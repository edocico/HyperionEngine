//! Lock-free Single-Producer Single-Consumer (SPSC) ring buffer consumer.
//!
//! Memory layout (lives in a SharedArrayBuffer):
//!
//! | Offset | Size | Description                              |
//! |--------|------|------------------------------------------|
//! | 0      | 4    | `write_head` (u32, atomic) -- written by JS |
//! | 4      | 4    | `read_head`  (u32, atomic) -- written by Rust |
//! | 8      | 4    | `capacity`   (u32, const)                |
//! | 12     | 4    | padding (16-byte alignment)              |
//! | 16     | cap  | `data[0..capacity]` -- command bytes     |
//!
//! Each command in the data region is encoded as:
//!   `[cmd_type: u8][entity_id: u32 LE][payload: variable]`

use std::sync::atomic::{AtomicU32, Ordering};

// ---------------------------------------------------------------------------
// CommandType
// ---------------------------------------------------------------------------

/// Discriminant for every command that can travel through the ring buffer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum CommandType {
    Noop = 0,
    SpawnEntity = 1,
    DespawnEntity = 2,
    SetPosition = 3,
    SetRotation = 4,
    SetScale = 5,
    SetVelocity = 6,
}

impl CommandType {
    /// Try to convert a raw byte into a `CommandType`.
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Self::Noop),
            1 => Some(Self::SpawnEntity),
            2 => Some(Self::DespawnEntity),
            3 => Some(Self::SetPosition),
            4 => Some(Self::SetRotation),
            5 => Some(Self::SetScale),
            6 => Some(Self::SetVelocity),
            _ => None,
        }
    }

    /// Number of payload bytes that follow the 5-byte header (cmd_type + entity_id).
    pub fn payload_size(self) -> usize {
        match self {
            Self::Noop | Self::SpawnEntity | Self::DespawnEntity => 0,
            Self::SetPosition | Self::SetScale | Self::SetVelocity => 12, // 3 x f32
            Self::SetRotation => 16, // 4 x f32
        }
    }

    /// Total on-wire size: 1 (cmd_type) + 4 (entity_id) + payload.
    pub fn message_size(self) -> usize {
        1 + 4 + self.payload_size()
    }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

/// A fully decoded command read from the ring buffer.
#[derive(Debug, Clone, PartialEq)]
pub struct Command {
    pub cmd_type: CommandType,
    pub entity_id: u32,
    /// Payload bytes (up to 16). Only the first `cmd_type.payload_size()` bytes
    /// are meaningful; the rest are zero-padded.
    pub payload: [u8; 16],
}

// ---------------------------------------------------------------------------
// parse_commands (flat byte-slice parser)
// ---------------------------------------------------------------------------

/// Parse commands from a flat byte slice.
///
/// This is the non-circular counterpart to `RingBufferConsumer::drain()`.
/// Used when the Worker extracts bytes from the SharedArrayBuffer and passes
/// them to WASM as a contiguous `&[u8]`.
pub fn parse_commands(data: &[u8]) -> Vec<Command> {
    let mut commands = Vec::new();
    let mut pos = 0;

    while pos < data.len() {
        let cmd_byte = data[pos];
        let Some(cmd_type) = CommandType::from_u8(cmd_byte) else {
            break;
        };

        let msg_size = cmd_type.message_size();
        if pos + msg_size > data.len() {
            break;
        }

        let mut id_bytes = [0u8; 4];
        id_bytes.copy_from_slice(&data[pos + 1..pos + 5]);
        let entity_id = u32::from_le_bytes(id_bytes);

        let mut payload = [0u8; 16];
        let psize = cmd_type.payload_size();
        if psize > 0 {
            payload[..psize].copy_from_slice(&data[pos + 5..pos + 5 + psize]);
        }

        commands.push(Command {
            cmd_type,
            entity_id,
            payload,
        });

        pos += msg_size;
    }

    commands
}

// ---------------------------------------------------------------------------
// RingBufferConsumer
// ---------------------------------------------------------------------------

/// Consumer (Rust) side of the SPSC ring buffer that lives inside a
/// SharedArrayBuffer.
///
/// # Safety
///
/// The caller must ensure:
/// - `ptr` points to a valid region of at least `16 + capacity` bytes.
/// - The memory is backed by a SharedArrayBuffer and remains valid for the
///   lifetime of this struct.
/// - There is exactly one producer (JS) and one consumer (this struct).
pub struct RingBufferConsumer {
    /// Pointer to offset 0 of the shared buffer (write_head).
    base: *mut u8,
    /// Ring capacity in bytes (read once at construction time).
    capacity: usize,
}

// The struct is !Send by default because of the raw pointer.  We assert Send
// manually — the SPSC contract guarantees only one consumer thread.
unsafe impl Send for RingBufferConsumer {}

impl RingBufferConsumer {
    /// Create a new consumer from a raw pointer to the shared buffer.
    ///
    /// # Safety
    ///
    /// See struct-level safety docs.
    pub unsafe fn new(ptr: *mut u8, capacity: usize) -> Self {
        Self {
            base: ptr,
            capacity,
        }
    }

    // -- atomic accessors ---------------------------------------------------

    fn write_head(&self) -> u32 {
        // SAFETY: offset 0 is a u32 written atomically by the producer.
        unsafe {
            let atom = &*(self.base as *const AtomicU32);
            atom.load(Ordering::Acquire)
        }
    }

    fn read_head(&self) -> u32 {
        // SAFETY: offset 4 is a u32 written atomically by the consumer.
        unsafe {
            let atom = &*(self.base.add(4) as *const AtomicU32);
            atom.load(Ordering::Relaxed)
        }
    }

    fn set_read_head(&self, value: u32) {
        // SAFETY: offset 4 is a u32 written atomically by the consumer.
        unsafe {
            let atom = &*(self.base.add(4) as *const AtomicU32);
            atom.store(value, Ordering::Release);
        }
    }

    fn data_ptr(&self) -> *const u8 {
        // Data region starts at offset 16.
        unsafe { self.base.add(16) }
    }

    // -- data helpers -------------------------------------------------------

    /// Read a single byte from the circular data region at the given absolute
    /// offset (which will be wrapped modulo capacity).
    fn read_byte(&self, offset: usize) -> u8 {
        let wrapped = offset % self.capacity;
        unsafe { *self.data_ptr().add(wrapped) }
    }

    /// Read `len` contiguous bytes from the circular data region starting at
    /// `offset`, handling wrap-around transparently.
    fn read_bytes(&self, offset: usize, len: usize) -> Vec<u8> {
        let mut buf = Vec::with_capacity(len);
        for i in 0..len {
            buf.push(self.read_byte(offset + i));
        }
        buf
    }

    // -- public API ---------------------------------------------------------

    /// How many unread bytes are available in the buffer right now?
    pub fn available(&self) -> usize {
        let wh = self.write_head() as usize;
        let rh = self.read_head() as usize;
        if wh >= rh {
            wh - rh
        } else {
            self.capacity - rh + wh
        }
    }

    /// Read **all** available commands and advance `read_head` atomically.
    ///
    /// Returns an empty `Vec` when no data is available.
    pub fn drain(&self) -> Vec<Command> {
        let mut commands = Vec::new();
        let mut rh = self.read_head() as usize;
        let wh = self.write_head() as usize;

        while rh != wh {
            // 1. Read command type byte.
            let type_byte = self.read_byte(rh);
            let cmd_type = match CommandType::from_u8(type_byte) {
                Some(ct) => ct,
                None => break, // Unknown command — stop draining.
            };

            let msg_size = cmd_type.message_size();

            // Make sure the full message is actually available.
            let avail = if wh >= rh {
                wh - rh
            } else {
                self.capacity - rh + wh
            };
            if avail < msg_size {
                break; // Incomplete message — wait for producer.
            }

            // 2. Read entity_id (4 bytes, little-endian) right after cmd_type.
            let id_bytes = self.read_bytes(rh + 1, 4);
            let entity_id = u32::from_le_bytes([
                id_bytes[0],
                id_bytes[1],
                id_bytes[2],
                id_bytes[3],
            ]);

            // 3. Read payload.
            let payload_size = cmd_type.payload_size();
            let mut payload = [0u8; 16];
            if payload_size > 0 {
                let raw = self.read_bytes(rh + 5, payload_size);
                payload[..payload_size].copy_from_slice(&raw);
            }

            commands.push(Command {
                cmd_type,
                entity_id,
                payload,
            });

            rh = (rh + msg_size) % self.capacity;
        }

        // Advance read_head atomically so the producer can reclaim space.
        self.set_read_head(rh as u32);

        commands
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Helper: allocate a properly laid-out buffer on the heap and return the
    /// raw pointer together with the owning `Vec` (so it won't be dropped).
    fn make_buffer(capacity: usize) -> (Vec<u8>, *mut u8) {
        let total = 16 + capacity; // header + data
        let mut buf = vec![0u8; total];
        // Write capacity at offset 8 (little-endian).
        let cap_bytes = (capacity as u32).to_le_bytes();
        buf[8..12].copy_from_slice(&cap_bytes);
        let ptr = buf.as_mut_ptr();
        (buf, ptr)
    }

    /// Write a raw write_head value into the buffer header.
    fn set_write_head(buf: &mut [u8], value: u32) {
        let bytes = value.to_le_bytes();
        buf[0..4].copy_from_slice(&bytes);
    }

    /// Write raw bytes into the data region starting at `offset`.
    fn write_data(buf: &mut [u8], offset: usize, data: &[u8]) {
        let start = 16 + offset;
        buf[start..start + data.len()].copy_from_slice(data);
    }

    // -- Tests --------------------------------------------------------------

    #[test]
    fn empty_buffer_drains_nothing() {
        let (buf, ptr) = make_buffer(64);
        let consumer = unsafe { RingBufferConsumer::new(ptr, 64) };
        let commands = consumer.drain();
        assert!(commands.is_empty());
        // Keep buf alive.
        drop(buf);
    }

    #[test]
    fn reads_spawn_command() {
        let (mut buf, ptr) = make_buffer(64);

        // SpawnEntity (type=1) for entity 42.  Message size = 5.
        let entity_id: u32 = 42;
        let mut msg = vec![1u8]; // cmd_type
        msg.extend_from_slice(&entity_id.to_le_bytes());
        write_data(&mut buf, 0, &msg);
        set_write_head(&mut buf, msg.len() as u32);

        let consumer = unsafe { RingBufferConsumer::new(ptr, 64) };
        let commands = consumer.drain();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].cmd_type, CommandType::SpawnEntity);
        assert_eq!(commands[0].entity_id, 42);
        assert_eq!(commands[0].payload, [0u8; 16]);
    }

    #[test]
    fn reads_position_command_with_payload() {
        let (mut buf, ptr) = make_buffer(128);

        // SetPosition (type=3) for entity 7, payload = 3 x f32.
        let entity_id: u32 = 7;
        let x: f32 = 1.0;
        let y: f32 = 2.0;
        let z: f32 = 3.0;
        let mut msg = vec![3u8];
        msg.extend_from_slice(&entity_id.to_le_bytes());
        msg.extend_from_slice(&x.to_le_bytes());
        msg.extend_from_slice(&y.to_le_bytes());
        msg.extend_from_slice(&z.to_le_bytes());
        write_data(&mut buf, 0, &msg);
        set_write_head(&mut buf, msg.len() as u32);

        let consumer = unsafe { RingBufferConsumer::new(ptr, 128) };
        let commands = consumer.drain();

        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].cmd_type, CommandType::SetPosition);
        assert_eq!(commands[0].entity_id, 7);

        // Verify payload contains the three floats.
        let px = f32::from_le_bytes(commands[0].payload[0..4].try_into().unwrap());
        let py = f32::from_le_bytes(commands[0].payload[4..8].try_into().unwrap());
        let pz = f32::from_le_bytes(commands[0].payload[8..12].try_into().unwrap());
        assert_eq!((px, py, pz), (1.0, 2.0, 3.0));
    }

    #[test]
    fn reads_multiple_commands() {
        let (mut buf, ptr) = make_buffer(256);

        let mut offset = 0usize;

        // Command 1: SpawnEntity for entity 1 (5 bytes).
        let mut msg1 = vec![1u8];
        msg1.extend_from_slice(&1u32.to_le_bytes());
        write_data(&mut buf, offset, &msg1);
        offset += msg1.len();

        // Command 2: DespawnEntity for entity 2 (5 bytes).
        let mut msg2 = vec![2u8];
        msg2.extend_from_slice(&2u32.to_le_bytes());
        write_data(&mut buf, offset, &msg2);
        offset += msg2.len();

        // Command 3: SetScale for entity 3 (5 + 12 = 17 bytes).
        let mut msg3 = vec![5u8];
        msg3.extend_from_slice(&3u32.to_le_bytes());
        msg3.extend_from_slice(&1.0f32.to_le_bytes());
        msg3.extend_from_slice(&1.0f32.to_le_bytes());
        msg3.extend_from_slice(&1.0f32.to_le_bytes());
        write_data(&mut buf, offset, &msg3);
        offset += msg3.len();

        set_write_head(&mut buf, offset as u32);

        let consumer = unsafe { RingBufferConsumer::new(ptr, 256) };
        let commands = consumer.drain();

        assert_eq!(commands.len(), 3);
        assert_eq!(commands[0].cmd_type, CommandType::SpawnEntity);
        assert_eq!(commands[0].entity_id, 1);
        assert_eq!(commands[1].cmd_type, CommandType::DespawnEntity);
        assert_eq!(commands[1].entity_id, 2);
        assert_eq!(commands[2].cmd_type, CommandType::SetScale);
        assert_eq!(commands[2].entity_id, 3);
    }

    // -- parse_commands tests ------------------------------------------------

    #[test]
    fn parse_commands_reads_spawn() {
        let mut data = Vec::new();
        data.push(CommandType::SpawnEntity as u8);
        data.extend_from_slice(&42u32.to_le_bytes());

        let cmds = parse_commands(&data);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].cmd_type, CommandType::SpawnEntity);
        assert_eq!(cmds[0].entity_id, 42);
    }

    #[test]
    fn parse_commands_reads_position_payload() {
        let mut data = Vec::new();
        data.push(CommandType::SetPosition as u8);
        data.extend_from_slice(&7u32.to_le_bytes());
        data.extend_from_slice(&1.0f32.to_le_bytes());
        data.extend_from_slice(&2.0f32.to_le_bytes());
        data.extend_from_slice(&3.0f32.to_le_bytes());

        let cmds = parse_commands(&data);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].entity_id, 7);
        let x = f32::from_le_bytes(cmds[0].payload[0..4].try_into().unwrap());
        let y = f32::from_le_bytes(cmds[0].payload[4..8].try_into().unwrap());
        let z = f32::from_le_bytes(cmds[0].payload[8..12].try_into().unwrap());
        assert_eq!((x, y, z), (1.0, 2.0, 3.0));
    }

    #[test]
    fn parse_commands_reads_multiple() {
        let mut data = Vec::new();
        // Spawn entity 1
        data.push(CommandType::SpawnEntity as u8);
        data.extend_from_slice(&1u32.to_le_bytes());
        // Despawn entity 2
        data.push(CommandType::DespawnEntity as u8);
        data.extend_from_slice(&2u32.to_le_bytes());

        let cmds = parse_commands(&data);
        assert_eq!(cmds.len(), 2);
        assert_eq!(cmds[0].entity_id, 1);
        assert_eq!(cmds[1].cmd_type, CommandType::DespawnEntity);
        assert_eq!(cmds[1].entity_id, 2);
    }

    #[test]
    fn parse_commands_handles_incomplete() {
        // Only 3 bytes — not enough for a full command (need 5 minimum)
        let data = vec![CommandType::SpawnEntity as u8, 0, 0];
        let cmds = parse_commands(&data);
        assert!(cmds.is_empty());
    }

    #[test]
    fn parse_commands_handles_empty() {
        let cmds = parse_commands(&[]);
        assert!(cmds.is_empty());
    }

    // -- drain tests (continued) ----------------------------------------------

    #[test]
    fn drain_advances_read_head() {
        let (mut buf, ptr) = make_buffer(64);

        // Write a Noop command (5 bytes).
        let mut msg = vec![0u8]; // Noop
        msg.extend_from_slice(&0u32.to_le_bytes());
        write_data(&mut buf, 0, &msg);
        set_write_head(&mut buf, msg.len() as u32);

        let consumer = unsafe { RingBufferConsumer::new(ptr, 64) };

        // Before drain, read_head should be 0.
        assert_eq!(consumer.read_head(), 0);

        let commands = consumer.drain();
        assert_eq!(commands.len(), 1);

        // After drain, read_head should have advanced by the message size (5).
        assert_eq!(consumer.read_head(), 5);

        // A second drain should yield nothing.
        let commands2 = consumer.drain();
        assert!(commands2.is_empty());
    }
}

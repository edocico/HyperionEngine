//! Lock-free Single-Producer Single-Consumer (SPSC) ring buffer consumer.
//!
//! Memory layout (lives in a SharedArrayBuffer):
//!
//! | Offset | Size | Description                                   |
//! |--------|------|-----------------------------------------------|
//! | 0      | 4    | `write_head` (u32, atomic) -- written by JS   |
//! | 4      | 4    | `read_head`  (u32, atomic) -- written by Rust  |
//! | 8      | 4    | `capacity`   (u32, const)                     |
//! | 12     | 4    | padding                                       |
//! | 16     | 4    | `heartbeat_w1` (u32, atomic) -- worker 1       |
//! | 20     | 4    | `heartbeat_w2` (u32, atomic) -- worker 2       |
//! | 24     | 4    | `supervisor_flags` (u32, atomic)               |
//! | 28     | 4    | `overflow_counter` (u32, atomic)               |
//! | 32     | cap  | `data[0..capacity]` -- command bytes           |
//!
//! Each command in the data region is encoded as:
//!   `[cmd_type: u8][entity_id: u32 LE][payload: variable]`

use std::sync::atomic::{AtomicU32, Ordering};

/// Header size in bytes. Fields:
/// [0..4] write_head, [4..8] read_head, [8..12] capacity, [12..16] padding,
/// [16..20] heartbeat_w1, [20..24] heartbeat_w2, [24..28] supervisor_flags, [28..32] overflow_counter
const HEADER_SIZE: usize = 32;

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
    SetTextureLayer = 7,
    SetMeshHandle = 8,
    SetRenderPrimitive = 9,
    SetParent = 10,
    SetPrimParams0 = 11,   // params[0..3], 4 × f32 = 16 bytes
    SetPrimParams1 = 12,   // params[4..7], 4 × f32 = 16 bytes
    SetListenerPosition = 13, // listener xyz, 3 × f32 = 12 bytes
    SetRotation2D = 14,       // f32 angle (radians)
    SetTransparent = 15,      // u8: 0=opaque, 1=transparent
    SetDepth = 16,            // f32 z depth for 2.5D ordering

    // ── Physics: body commands ──
    CreateRigidBody = 17,       // 1B: body_type (0=dynamic, 1=fixed, 2=kinematic)
    DestroyRigidBody = 18,      // 0B
    CreateCollider = 19,        // 16B max: shape_type(1B) + params(up to 12B)
    DestroyCollider = 20,       // 0B
    SetLinearDamping = 21,      // 4B: f32
    SetAngularDamping = 22,     // 4B: f32
    SetGravityScale = 23,       // 4B: f32
    SetCCDEnabled = 24,         // 1B: u8 bool
    ApplyForce = 25,            // 8B: fx(f32) + fy(f32)
    ApplyImpulse = 26,          // 8B: ix(f32) + iy(f32)
    ApplyTorque = 27,           // 4B: f32

    // ── Physics: collider overrides ──
    SetColliderSensor = 28,     // 1B: u8 bool
    SetColliderDensity = 29,    // 4B: f32
    SetColliderRestitution = 30, // 4B: f32
    SetColliderFriction = 31,   // 4B: f32
    SetCollisionGroups = 32,    // 4B: membership(u16) + filter(u16)

    // ── Physics: joints ──
    CreateRevoluteJoint = 33,   // 16B: joint_id(u32) + entity_b(u32) + anchor_ax(f32) + anchor_ay(f32)
    CreatePrismaticJoint = 34,  // 16B: joint_id(u32) + entity_b(u32) + axis_x(f32) + axis_y(f32)
    CreateFixedJoint = 35,      // 8B: joint_id(u32) + entity_b(u32)
    CreateRopeJoint = 36,       // 12B: joint_id(u32) + entity_b(u32) + max_dist(f32)
    RemoveJoint = 37,           // 4B: joint_id(u32)
    SetJointMotor = 38,         // 12B: joint_id(u32) + target_vel(f32) + max_force(f32)
    SetJointLimits = 39,        // 12B: joint_id(u32) + min(f32) + max(f32)

    // ── Physics: spring joints & anchor overrides ──
    CreateSpringJoint = 40,     // 12B: joint_id(u32) + entity_b(u32) + rest_length(f32)
    SetSpringParams = 41,       // 12B: joint_id(u32) + stiffness(f32) + damping(f32)
    SetJointAnchorB = 42,       // 12B: joint_id(u32) + bx(f32) + by(f32)
    SetJointAnchorA = 43,       // 12B: joint_id(u32) + ax(f32) + ay(f32)

    // ── Physics: character controller ──
    CreateCharacterController = 44, // 1B: reserved flags
    SetCharacterConfig = 45,        // 16B: packed config
    MoveCharacter = 46,             // 8B: dx(f32) + dy(f32)
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
            7 => Some(Self::SetTextureLayer),
            8 => Some(Self::SetMeshHandle),
            9 => Some(Self::SetRenderPrimitive),
            10 => Some(Self::SetParent),
            11 => Some(Self::SetPrimParams0),
            12 => Some(Self::SetPrimParams1),
            13 => Some(Self::SetListenerPosition),
            14 => Some(Self::SetRotation2D),
            15 => Some(Self::SetTransparent),
            16 => Some(Self::SetDepth),
            // Physics: body commands
            17 => Some(Self::CreateRigidBody),
            18 => Some(Self::DestroyRigidBody),
            19 => Some(Self::CreateCollider),
            20 => Some(Self::DestroyCollider),
            21 => Some(Self::SetLinearDamping),
            22 => Some(Self::SetAngularDamping),
            23 => Some(Self::SetGravityScale),
            24 => Some(Self::SetCCDEnabled),
            25 => Some(Self::ApplyForce),
            26 => Some(Self::ApplyImpulse),
            27 => Some(Self::ApplyTorque),
            // Physics: collider overrides
            28 => Some(Self::SetColliderSensor),
            29 => Some(Self::SetColliderDensity),
            30 => Some(Self::SetColliderRestitution),
            31 => Some(Self::SetColliderFriction),
            32 => Some(Self::SetCollisionGroups),
            // Physics: joints
            33 => Some(Self::CreateRevoluteJoint),
            34 => Some(Self::CreatePrismaticJoint),
            35 => Some(Self::CreateFixedJoint),
            36 => Some(Self::CreateRopeJoint),
            37 => Some(Self::RemoveJoint),
            38 => Some(Self::SetJointMotor),
            39 => Some(Self::SetJointLimits),
            // Physics: spring joints & anchor overrides
            40 => Some(Self::CreateSpringJoint),
            41 => Some(Self::SetSpringParams),
            42 => Some(Self::SetJointAnchorB),
            43 => Some(Self::SetJointAnchorA),
            // Physics: character controller
            44 => Some(Self::CreateCharacterController),
            45 => Some(Self::SetCharacterConfig),
            46 => Some(Self::MoveCharacter),
            _ => None,
        }
    }

    /// Number of payload bytes that follow the 5-byte header (cmd_type + entity_id).
    pub fn payload_size(self) -> usize {
        match self {
            Self::Noop | Self::DespawnEntity => 0,
            Self::SpawnEntity => 1,           // u8: 0=3D, 1=2D
            Self::SetPosition | Self::SetScale | Self::SetVelocity => 12, // 3 x f32
            Self::SetRotation => 16, // 4 x f32
            Self::SetTextureLayer => 4, // 1 x u32
            Self::SetMeshHandle => 4,       // u32 LE
            Self::SetRenderPrimitive => 4,  // u8 padded to 4 for alignment
            Self::SetParent => 4,           // parent entity id (u32 LE), 0xFFFFFFFF = unparent
            Self::SetPrimParams0 | Self::SetPrimParams1 => 16, // 4 × f32
            Self::SetListenerPosition => 12, // 3 × f32
            Self::SetRotation2D => 4,       // 1 × f32
            Self::SetTransparent => 1,      // 1 × u8
            Self::SetDepth => 4,            // 1 × f32
            // Physics: body commands
            Self::CreateRigidBody => 1,     // body_type u8
            Self::DestroyRigidBody | Self::DestroyCollider => 0,
            Self::CreateCollider => 16,     // shape_type(1B) + params(up to 12B)
            Self::SetLinearDamping | Self::SetAngularDamping | Self::SetGravityScale
            | Self::ApplyTorque => 4,       // 1 × f32
            Self::SetCCDEnabled | Self::SetColliderSensor => 1, // u8 bool
            Self::ApplyForce | Self::ApplyImpulse => 8, // 2 × f32
            // Physics: collider overrides
            Self::SetColliderDensity | Self::SetColliderRestitution
            | Self::SetColliderFriction | Self::SetCollisionGroups => 4, // f32 or 2×u16
            // Physics: joints
            Self::CreateRevoluteJoint | Self::CreatePrismaticJoint => 16, // joint_id + entity_b + 2×f32
            Self::CreateFixedJoint => 8,    // joint_id + entity_b
            Self::CreateRopeJoint => 12,    // joint_id + entity_b + f32
            Self::RemoveJoint => 4,         // joint_id
            Self::SetJointMotor | Self::SetJointLimits => 12, // joint_id + 2×f32
            // Physics: spring joints & anchor overrides
            Self::CreateSpringJoint | Self::SetSpringParams
            | Self::SetJointAnchorB | Self::SetJointAnchorA => 12, // joint_id + 2×f32
            // Physics: character controller
            Self::CreateCharacterController => 1,  // reserved flags
            Self::SetCharacterConfig => 16,        // packed config (see spec §3.2)
            Self::MoveCharacter => 8,              // dx(f32) + dy(f32)
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
/// - `ptr` points to a valid region of at least `HEADER_SIZE + capacity` bytes.
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
        // Data region starts at offset HEADER_SIZE.
        unsafe { self.base.add(HEADER_SIZE) }
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
        let total = HEADER_SIZE + capacity; // header + data
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
        let start = HEADER_SIZE + offset;
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

        // SpawnEntity (type=1) for entity 42.  Message size = 6 (1 cmd + 4 entity_id + 1 payload).
        let entity_id: u32 = 42;
        let mut msg = vec![1u8]; // cmd_type
        msg.extend_from_slice(&entity_id.to_le_bytes());
        msg.push(0); // 3D flag (payload byte)
        write_data(&mut buf, 0, &msg);
        set_write_head(&mut buf, msg.len() as u32);

        let consumer = unsafe { RingBufferConsumer::new(ptr, 64) };
        let commands = consumer.drain();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].cmd_type, CommandType::SpawnEntity);
        assert_eq!(commands[0].entity_id, 42);
        assert_eq!(commands[0].payload[0], 0); // 3D
    }

    #[test]
    fn reads_spawn_2d_command() {
        let (mut buf, ptr) = make_buffer(64);

        // SpawnEntity (type=1) for entity 7 with 2D flag.
        let entity_id: u32 = 7;
        let mut msg = vec![1u8]; // cmd_type
        msg.extend_from_slice(&entity_id.to_le_bytes());
        msg.push(1); // 2D flag
        write_data(&mut buf, 0, &msg);
        set_write_head(&mut buf, msg.len() as u32);

        let consumer = unsafe { RingBufferConsumer::new(ptr, 64) };
        let commands = consumer.drain();
        assert_eq!(commands.len(), 1);
        assert_eq!(commands[0].cmd_type, CommandType::SpawnEntity);
        assert_eq!(commands[0].entity_id, 7);
        assert_eq!(commands[0].payload[0], 1); // 2D
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

        // Command 1: SpawnEntity for entity 1 (6 bytes: 1 cmd + 4 id + 1 payload).
        let mut msg1 = vec![1u8];
        msg1.extend_from_slice(&1u32.to_le_bytes());
        msg1.push(0); // 3D flag
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
        data.push(0); // 3D flag (1 byte payload)

        let cmds = parse_commands(&data);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].cmd_type, CommandType::SpawnEntity);
        assert_eq!(cmds[0].entity_id, 42);
        assert_eq!(cmds[0].payload[0], 0); // 3D
    }

    #[test]
    fn parse_commands_reads_spawn_2d() {
        let mut data = Vec::new();
        data.push(CommandType::SpawnEntity as u8);
        data.extend_from_slice(&7u32.to_le_bytes());
        data.push(1); // 2D flag

        let cmds = parse_commands(&data);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].cmd_type, CommandType::SpawnEntity);
        assert_eq!(cmds[0].entity_id, 7);
        assert_eq!(cmds[0].payload[0], 1); // 2D
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
        // Spawn entity 1 (6 bytes: 1 cmd + 4 id + 1 payload)
        data.push(CommandType::SpawnEntity as u8);
        data.extend_from_slice(&1u32.to_le_bytes());
        data.push(0); // 3D flag
        // Despawn entity 2 (5 bytes: 1 cmd + 4 id)
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
        // Only 3 bytes — not enough for a full command (need 5 minimum for Noop/Despawn, 6 for Spawn)
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
    fn parse_commands_reads_set_texture_layer() {
        let mut data = Vec::new();
        data.push(CommandType::SetTextureLayer as u8);
        data.extend_from_slice(&5u32.to_le_bytes());       // entity_id = 5
        data.extend_from_slice(&0x0002_000Au32.to_le_bytes()); // tier 2, layer 10
        let cmds = parse_commands(&data);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].cmd_type, CommandType::SetTextureLayer);
        assert_eq!(cmds[0].entity_id, 5);
        let packed = u32::from_le_bytes(cmds[0].payload[0..4].try_into().unwrap());
        assert_eq!(packed, 0x0002_000A);
    }

    #[test]
    fn parse_set_mesh_handle() {
        // cmd=8, entity_id=1, payload=42u32 LE
        let data = [
            8, 1, 0, 0, 0, // cmd + entity_id
            42, 0, 0, 0,    // mesh handle u32 LE
        ];
        let cmds = parse_commands(&data);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].cmd_type, CommandType::SetMeshHandle);
        assert_eq!(cmds[0].entity_id, 1);
        let handle = u32::from_le_bytes(cmds[0].payload[0..4].try_into().unwrap());
        assert_eq!(handle, 42);
    }

    #[test]
    fn parse_set_render_primitive() {
        // cmd=9, entity_id=2, payload=1u8 padded to 4 bytes
        let data = [
            9, 2, 0, 0, 0, // cmd + entity_id
            1, 0, 0, 0,     // render primitive u8 padded to u32
        ];
        let cmds = parse_commands(&data);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].cmd_type, CommandType::SetRenderPrimitive);
        assert_eq!(cmds[0].entity_id, 2);
        assert_eq!(cmds[0].payload[0], 1);
    }

    #[test]
    fn parse_set_parent() {
        // cmd=10, entity_id=5, payload=parent_id=3 (u32 LE)
        let data = [
            10, 5, 0, 0, 0, // cmd + entity_id
            3, 0, 0, 0,      // parent entity id
        ];
        let cmds = parse_commands(&data);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].cmd_type, CommandType::SetParent);
        let parent = u32::from_le_bytes(cmds[0].payload[0..4].try_into().unwrap());
        assert_eq!(parent, 3);
    }

    #[test]
    fn header_size_is_32_bytes() {
        assert_eq!(HEADER_SIZE, 32);
    }

    #[test]
    fn set_prim_params_0_round_trip() {
        let cmd_type = CommandType::from_u8(11).unwrap();
        assert_eq!(cmd_type, CommandType::SetPrimParams0);
        assert_eq!(cmd_type.payload_size(), 16);
    }

    #[test]
    fn set_prim_params_1_round_trip() {
        let cmd_type = CommandType::from_u8(12).unwrap();
        assert_eq!(cmd_type, CommandType::SetPrimParams1);
        assert_eq!(cmd_type.payload_size(), 16);
    }

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

    #[test]
    fn parse_set_listener_position() {
        let mut data = Vec::new();
        data.push(CommandType::SetListenerPosition as u8);
        data.extend_from_slice(&0u32.to_le_bytes()); // entity_id = 0 (sentinel)
        data.extend_from_slice(&1.5f32.to_le_bytes()); // x
        data.extend_from_slice(&2.5f32.to_le_bytes()); // y
        data.extend_from_slice(&3.5f32.to_le_bytes()); // z
        let cmds = parse_commands(&data);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].cmd_type, CommandType::SetListenerPosition);
        assert_eq!(cmds[0].entity_id, 0);
        let x = f32::from_le_bytes(cmds[0].payload[0..4].try_into().unwrap());
        let y = f32::from_le_bytes(cmds[0].payload[4..8].try_into().unwrap());
        let z = f32::from_le_bytes(cmds[0].payload[8..12].try_into().unwrap());
        assert_eq!((x, y, z), (1.5, 2.5, 3.5));
    }

    #[test]
    fn set_listener_position_payload_size_is_12() {
        let cmd_type = CommandType::from_u8(13).unwrap();
        assert_eq!(cmd_type, CommandType::SetListenerPosition);
        assert_eq!(cmd_type.payload_size(), 12);
    }

    #[test]
    fn set_rotation_2d_round_trip() {
        let cmd = Command {
            cmd_type: CommandType::SetRotation2D,
            entity_id: 42,
            payload: {
                let mut p = [0u8; 16];
                p[0..4].copy_from_slice(&std::f32::consts::FRAC_PI_4.to_le_bytes());
                p
            },
        };
        assert_eq!(cmd.cmd_type as u8, 14);
        let angle = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
        assert!((angle - std::f32::consts::FRAC_PI_4).abs() < 1e-7);
    }

    #[test]
    fn set_transparent_round_trip() {
        let cmd = Command {
            cmd_type: CommandType::SetTransparent,
            entity_id: 99,
            payload: {
                let mut p = [0u8; 16];
                p[0] = 1;
                p
            },
        };
        assert_eq!(cmd.cmd_type as u8, 15);
        assert_eq!(cmd.payload[0], 1);
    }

    #[test]
    fn set_depth_round_trip() {
        let cmd = Command {
            cmd_type: CommandType::SetDepth,
            entity_id: 7,
            payload: {
                let mut p = [0u8; 16];
                p[0..4].copy_from_slice(&5.0f32.to_le_bytes());
                p
            },
        };
        assert_eq!(cmd.cmd_type as u8, 16);
        let depth = f32::from_le_bytes(cmd.payload[0..4].try_into().unwrap());
        assert!((depth - 5.0).abs() < 1e-7);
    }

    #[test]
    fn parse_set_rotation_2d() {
        let mut data = Vec::new();
        data.push(CommandType::SetRotation2D as u8);
        data.extend_from_slice(&42u32.to_le_bytes());
        data.extend_from_slice(&std::f32::consts::FRAC_PI_4.to_le_bytes());
        let cmds = parse_commands(&data);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].cmd_type, CommandType::SetRotation2D);
        assert_eq!(cmds[0].entity_id, 42);
        let angle = f32::from_le_bytes(cmds[0].payload[0..4].try_into().unwrap());
        assert!((angle - std::f32::consts::FRAC_PI_4).abs() < 1e-7);
    }

    #[test]
    fn parse_set_transparent() {
        // cmd=15, entity_id=99, payload=1 byte
        let data = [
            15, 99, 0, 0, 0, // cmd + entity_id
            1,                // transparent flag
        ];
        let cmds = parse_commands(&data);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].cmd_type, CommandType::SetTransparent);
        assert_eq!(cmds[0].entity_id, 99);
        assert_eq!(cmds[0].payload[0], 1);
    }

    #[test]
    fn parse_set_depth() {
        let mut data = Vec::new();
        data.push(CommandType::SetDepth as u8);
        data.extend_from_slice(&7u32.to_le_bytes());
        data.extend_from_slice(&5.0f32.to_le_bytes());
        let cmds = parse_commands(&data);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].cmd_type, CommandType::SetDepth);
        assert_eq!(cmds[0].entity_id, 7);
        let depth = f32::from_le_bytes(cmds[0].payload[0..4].try_into().unwrap());
        assert!((depth - 5.0).abs() < 1e-7);
    }

    #[test]
    fn spawn_entity_payload_size_is_1() {
        let cmd_type = CommandType::from_u8(1).unwrap();
        assert_eq!(cmd_type, CommandType::SpawnEntity);
        assert_eq!(cmd_type.payload_size(), 1);
        assert_eq!(cmd_type.message_size(), 6); // 1 cmd + 4 entity_id + 1 payload
    }

    #[test]
    fn set_rotation_2d_payload_size_is_4() {
        let cmd_type = CommandType::from_u8(14).unwrap();
        assert_eq!(cmd_type, CommandType::SetRotation2D);
        assert_eq!(cmd_type.payload_size(), 4);
    }

    #[test]
    fn set_transparent_payload_size_is_1() {
        let cmd_type = CommandType::from_u8(15).unwrap();
        assert_eq!(cmd_type, CommandType::SetTransparent);
        assert_eq!(cmd_type.payload_size(), 1);
    }

    #[test]
    fn set_depth_payload_size_is_4() {
        let cmd_type = CommandType::from_u8(16).unwrap();
        assert_eq!(cmd_type, CommandType::SetDepth);
        assert_eq!(cmd_type.payload_size(), 4);
    }

    #[test]
    fn physics_command_types_round_trip() {
        // All 25 physics commands should survive from_u8 round-trip
        for val in 17..=43u8 {
            let ct = CommandType::from_u8(val);
            assert!(ct.is_some(), "CommandType::from_u8({val}) should be Some");
        }
    }

    #[test]
    fn physics_payload_sizes_within_limit() {
        for val in 17..=43u8 {
            if let Some(ct) = CommandType::from_u8(val) {
                assert!(ct.payload_size() <= 16,
                    "CommandType {val} payload {} exceeds 16-byte limit",
                    ct.payload_size());
            }
        }
    }

    #[test]
    fn character_controller_command_types_round_trip() {
        for val in 44..=46u8 {
            let ct = CommandType::from_u8(val);
            assert!(ct.is_some(), "CommandType::from_u8({val}) should be Some");
        }
        assert!(CommandType::from_u8(47).is_none(), "47 should be None");
    }

    #[test]
    fn character_controller_payload_sizes() {
        assert_eq!(CommandType::CreateCharacterController.payload_size(), 1);
        assert_eq!(CommandType::SetCharacterConfig.payload_size(), 16);
        assert_eq!(CommandType::MoveCharacter.payload_size(), 8);
    }
}

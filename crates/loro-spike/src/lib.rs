use loro::{ExportMode, LoroDoc};
use wasm_bindgen::prelude::*;

use std::cell::RefCell;

thread_local! {
    static DOCS: RefCell<Vec<LoroDoc>> = RefCell::new(Vec::new());
}

/// Creates a new LoroDoc and returns its index.
#[wasm_bindgen]
pub fn create_doc() -> u32 {
    DOCS.with(|docs| {
        let mut docs = docs.borrow_mut();
        let idx = docs.len() as u32;
        docs.push(LoroDoc::new());
        idx
    })
}

/// Inserts `count` entries into a Map container named "entities" on the given doc.
/// Keys are "e0", "e1", ..., values are the index as f64.
#[wasm_bindgen]
pub fn apply_operations(doc_id: u32, count: u32) {
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = &docs[doc_id as usize];
        let map = doc.get_map("entities");
        for i in 0..count {
            let key = format!("e{}", i);
            map.insert(&key, i as f64).unwrap();
        }
    })
}

/// Exports all updates from the doc as a byte vector.
#[wasm_bindgen]
pub fn export_updates(doc_id: u32) -> Vec<u8> {
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = &docs[doc_id as usize];
        doc.export(ExportMode::all_updates()).unwrap()
    })
}

/// Imports updates (exported from another doc) into this doc.
#[wasm_bindgen]
pub fn import_updates(doc_id: u32, data: &[u8]) {
    DOCS.with(|docs| {
        let docs = docs.borrow();
        let doc = &docs[doc_id as usize];
        doc.import(data).unwrap();
    })
}

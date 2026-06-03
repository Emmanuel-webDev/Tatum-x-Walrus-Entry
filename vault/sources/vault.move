module vault::vault {
    use sui::table::{Self, Table};
    use sui::clock::Clock;
    use sui::event;
    use std::string::String;

    // Errors
    const EEntryNotFound:   u64 = 1;
    const ENotOwner:        u64 = 2;
    const EDuplicateBlobId: u64 = 3;

    // Structs
    public struct VaultEntry has store, drop {
        blob_id:     String,
        filename:    String,
        mime_type:   String,
        size_bytes:  u64,
        uploaded_at: u64,
    }

    public struct VaultRegistry has key {
        id:      UID,
        owner:   address,
        entries: Table<String, VaultEntry>,
        index:   vector<String>,
    }

    // Events
    public struct EntryAdded has copy, drop {
        owner:       address,
        blob_id:     String,
        filename:    String,
        uploaded_at: u64,
    }

    public struct EntryRemoved has copy, drop {
        owner:   address,
        blob_id: String,
    }

    // Create a personal VaultRegistry — call once per wallet
    public entry fun create_registry(ctx: &mut TxContext) {
        let registry = VaultRegistry {
            id:      object::new(ctx),
            owner:   ctx.sender(),
            entries: table::new(ctx),
            index:   vector[],
        };
        transfer::transfer(registry, ctx.sender());
    }

    // Register a newly uploaded encrypted document
    public entry fun add_entry(
        registry:   &mut VaultRegistry,
        blob_id:    vector<u8>,
        filename:   vector<u8>,
        mime_type:  vector<u8>,
        size_bytes: u64,
        clock:      &Clock,
        ctx:        &mut TxContext,
    ) {
        assert!(registry.owner == ctx.sender(), ENotOwner);

        let blob_id_str  = blob_id.to_string();
        let filename_str = filename.to_string();
        let mime_str     = mime_type.to_string();

        assert!(!registry.entries.contains(blob_id_str), EDuplicateBlobId);

        let entry = VaultEntry {
            blob_id:     blob_id_str,
            filename:    filename_str,
            mime_type:   mime_str,
            size_bytes,
            uploaded_at: clock.timestamp_ms(),
        };

        registry.entries.add(blob_id_str, entry);
        registry.index.push_back(blob_id_str);

        event::emit(EntryAdded {
            owner:       ctx.sender(),
            blob_id:     blob_id_str,
            filename:    filename_str,
            uploaded_at: clock.timestamp_ms(),
        });
    }

    // Remove an entry from the registry
    public entry fun remove_entry(
        registry: &mut VaultRegistry,
        blob_id:  vector<u8>,
        ctx:      &mut TxContext,
    ) {
        assert!(registry.owner == ctx.sender(), ENotOwner);

        let blob_id_str = blob_id.to_string();
        assert!(registry.entries.contains(blob_id_str), EEntryNotFound);

        registry.entries.remove(blob_id_str);

        let len = registry.index.length();
        let mut i = 0u64;
        while (i < len) {
            if (registry.index[i] == blob_id_str) {
                registry.index.remove(i);
                break
            };
            i = i + 1;
        };

        event::emit(EntryRemoved {
            owner:   ctx.sender(),
            blob_id: blob_id_str,
        });
    }

    // View helpers
    public fun entry_count(registry: &VaultRegistry): u64 {
        registry.index.length()
    }

    public fun has_entry(registry: &VaultRegistry, blob_id: String): bool {
        registry.entries.contains(blob_id)
    }

    public fun get_entry(registry: &VaultRegistry, blob_id: String): &VaultEntry {
        registry.entries.borrow(blob_id)
    }
}

# Backup and import formats

Open Settings → Data to import or export. Import is local and does not make API requests.

| Input | Supported format |
| --- | --- |
| DeepSeek ZIP | `export_format_version: 3`, conversations under `chat_sessions/` |
| Simple Chat JSON or ZIP | `simplechat-backup` v2; `simplechat-archive` v1 with `backup.json` |
| Chatbox JSON or ZIP | `chatbox-backup`, with JSON sessions or ZIP `sessions/` entries |
| Complete backup ZIP | `deepseek-plus-archive` v1 with `settings.json`, session records, and attachment files |

Incremental import skips existing conversation IDs. Replace matches by ID first, then the oldest conversation with the same title. Keep copies assigns new IDs on conflicts. Each successful conversation is committed with its attachment records; unmatched local conversations remain. Optional structural repair can restore orphaned branches or break cycles, but malformed records can still fail. See the local import report and export it as JSON if needed. Reports may contain chat titles, so check them before sharing.

The complete format stores the local data model, including branches, existing attachment originals, settings, recaps and presets. The DeepSeek-compatible export intentionally omits settings, recaps, presets and most non-image file bytes. Foreign clients may have fields the local data model cannot represent; Chatbox import only restores its visible chain. Do not use either export to transfer keys. An already-missing attachment original cannot be reconstructed.

ZIP support is limited to unencrypted, single-volume ZIP32 archives with stored or deflated entries. Android native exports are limited to 64 MiB per file in this snapshot. Keep the app open while migrating large archives.

Implementation: [archive input dispatch](../web/src/services/chat/history/input.ts), [per-conversation orchestration](../web/src/services/chat/history/importer.ts), [complete export](../web/src/services/chat/history/completeArchive.ts).
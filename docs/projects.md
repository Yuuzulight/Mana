# Projects

The native chat sidebar groups chats by project. Its project selector filters
the list and selects the project for a new chat. Projects can be created,
renamed, edited, or deleted from the Projects menu. The chat context menu moves
an existing chat. Forks inherit their parent's project unless explicitly moved
or ungrouped. Deleting a project keeps its chats and original files.

Standing instructions apply to project chats in every assistant mode. The
prompt composition report lists project instructions and references separately.

References are live links, not imported snapshots. Selecting files or a folder
in the native picker authorizes ongoing reading of that canonical path; folder
links include future files. Agent-requested links always enter the approval
queue. Unlinking revokes future retrieval, but does not erase earlier chat turns.
Legacy references without a live-access authorization must be selected again.

Before each project search, Mana enumerates the current linked files and builds
a transient, project-scoped lexical index using the existing retriever ranking
and document extraction. Changes and deletions take effect on the next search.
There is no background watcher, persistent content cache, new model process, or
cloud embedding request. File and directory handles are closed after use.

Text/code, Markdown, CSV, PDF, Word, Excel, and PowerPoint references are
supported. Folder enumeration omits hidden entries and generated dependency,
build, and Git directories. Nested symlinks and junctions are not followed.
Changed canonical roots require reselection rather than silently expanding
access. Searches are bounded to 2,000 files, 10,000 visited paths, 64MB of input,
and 2MB of extracted text. The five best 1,600-character excerpts are returned;
unavailable files and limits are recorded as warnings in the prompt report.
Reference content uses the shared untrusted-content framing and tool risk gate.

Project metadata and session assignments are stored beneath the ACP memory
directory in `projects/projects.json`, or the configured `MANA_PROJECTS_DIR`.
No reference contents are submitted to the global document or vector index.

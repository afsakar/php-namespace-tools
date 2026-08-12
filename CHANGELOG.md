# Changelog

## 0.4.0

- Repoint references to a moved class across the project: `use` statements,
  `::class` expressions, and class names written as plain strings, in both the
  single and doubled backslash spellings PHP requires.
- Reject candidate files on a substring test before running any pattern, so a
  move scans the project without a regex per file per moved class.

## 0.3.0

- Update namespaces when a directory is moved. VS Code reports one rename for
  the directory, so its PHP files are enumerated and renamespaced individually.
- Place edits without opening each file as a text document, so a bulk move does
  not load hundreds of editors.
- Refuse moves touching more than `maximumFilesPerMove` files, reporting the
  refusal in the output channel rather than silently doing part of the work.
- Report every namespace rewrite in the output channel.

## 0.2.0

- Rewrite the `namespace` declaration of a PHP file when it is moved, derived
  from the composer PSR-4 map.
- Mark completion results incomplete so a longer prefix reaches the language
  server instead of being filtered from a cached first result.
- Stop recomputing the import region on every parsed `use` statement.

## 0.1.0

- Initial release: completion items that rewrite a class against an already
  imported namespace prefix instead of adding a new `use` statement.

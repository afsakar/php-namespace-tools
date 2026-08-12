const vscode = require('vscode');

/** Symbol kinds that can legally appear as a type reference in PHP source. */
const TYPE_KINDS = new Set([
    vscode.SymbolKind.Class,
    vscode.SymbolKind.Interface,
    vscode.SymbolKind.Enum,
    vscode.SymbolKind.Struct,
    vscode.SymbolKind.Object,
]);

/**
 * The file with comments and string contents blanked out, character for
 * character, so every offset still lines up with the original.
 *
 * Import parsing runs on this. Without it a commented-out `use` is read as a
 * live import, and prose in a config file — which declares no type and so has
 * no import block to stop at — turns the English word "use" into one.
 *
 * Heredocs are not recognised; they sit inside function bodies, which the
 * top-level check already rejects.
 *
 * @param {string} text
 * @return {string}
 */
function maskLiterals(text) {
    const out = text.split('');
    let index = 0;

    const blankToEndOfLine = () => {
        while (index < text.length && text[index] !== '\n') {
            out[index++] = ' ';
        }
    };

    while (index < text.length) {
        const character = text[index];

        if (character === '/' && text[index + 1] === '/') {
            blankToEndOfLine();
        } else if (character === '#') {
            // `#[Attr]` is an attribute, not a comment.
            if (text[index + 1] === '[') {
                index++;
            } else {
                blankToEndOfLine();
            }
        } else if (character === '/' && text[index + 1] === '*') {
            out[index++] = ' ';
            out[index++] = ' ';

            while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
                out[index++] = ' ';
            }

            out[index++] = ' ';
            out[index++] = ' ';
        } else if (character === "'" || character === '"') {
            index++;

            while (index < text.length && text[index] !== character) {
                if (text[index] === '\\') {
                    out[index++] = ' ';
                }

                if (index < text.length) {
                    out[index++] = ' ';
                }
            }

            index++;
        } else {
            index++;
        }
    }

    return out.join('');
}

/**
 * Parse every `use` statement in a document into {fqn, alias} pairs.
 *
 * Handles plain imports, aliased imports and PHP 7 group imports. `use function`
 * and `use const` are skipped: they live in a separate resolution space and are
 * never valid as a type prefix.
 *
 * @param {string} text
 * @return {Array<{fqn: string, alias: string}>}
 */
function collectImports(text) {
    return importStatements(text).flatMap((statement) => statement.entries);
}

/**
 * The same imports, grouped by the statement that declared them and carrying
 * the offset and length of that statement.
 *
 * Removing an unused import needs the span of the whole statement, which the
 * flattened view throws away.
 *
 * @param {string} text
 * @return {Array<{index: number, length: number, grouped: boolean, entries: Array<{fqn: string, alias: string}>}>}
 */
function importStatements(text) {
    const statements = [];

    // Not line-anchored: `<?php use A;` and `use A; use B;` are both legal. The
    // body excludes `(` so a closure `use (...)` can never start a match.
    const pattern = /\buse\s+(function\s+|const\s+)?([^;(]+);/g;
    const masked = maskLiterals(text);

    let cursor = 0;
    let depth = 0;
    let match;

    while ((match = pattern.exec(masked)) !== null) {
        if (match[1]) {
            continue;
        }

        // An import lives at the top level. Anything deeper is a trait use in a
        // class body — including `new class { use SomeTrait; }`, which no
        // line-anchored search for a class declaration can see.
        for (; cursor < match.index; cursor++) {
            if (masked[cursor] === '{') {
                depth++;
            } else if (masked[cursor] === '}') {
                depth--;
            }
        }

        if (depth !== 0) {
            continue;
        }

        const body = match[2].trim();
        const group = body.match(/^(.+?)\\\{(.+)\}$/s);
        const entries = [];

        if (group) {
            for (const member of group[2].split(',')) {
                addImport(entries, `${group[1]}\\${member.trim()}`);
            }
        } else {
            addImport(entries, body);
        }

        if (entries.length > 0) {
            statements.push({ index: match.index, length: match[0].length, grouped: Boolean(group), entries });
        }
    }

    return statements;
}

/**
 * Whether a name is referred to anywhere outside the import block.
 *
 * A trailing backslash is deliberately allowed, so `use App\Filament\PageBlocks;`
 * counts as used by `PageBlocks\About\CompanyInfoBlock`. Docblock types and
 * attributes are plain text here and count too.
 *
 * @param {string} text
 * @param {string} alias
 * @return {boolean}
 */
function isNameUsed(text, alias) {
    return nameAppearsIn(textWithoutImports(text), alias);
}

/**
 * The file with its import statements blanked out, preserving every offset.
 *
 * Usage cannot be defined as "after the import block": a file with no type
 * declaration has no such boundary and would appear to use nothing, and an
 * attribute or a docblock `@property` sits above the class and would be missed.
 *
 * @param {string} text
 * @return {string}
 */
function textWithoutImports(text) {
    let masked = text;

    for (const statement of importStatements(text)) {
        masked =
            masked.slice(0, statement.index) +
            ' '.repeat(statement.length) +
            masked.slice(statement.index + statement.length);
    }

    return masked;
}

/**
 * @param {string} body
 * @param {string} alias
 * @return {boolean}
 */
function nameAppearsIn(body, alias) {
    return new RegExp(`(?<![A-Za-z0-9_$\\\\>:'"])${alias}(?![A-Za-z0-9_])`).test(body);
}

/**
 * Import statements whose every name goes unused in the file.
 *
 * A statement is only reported when all of its names are unused, so a group
 * import with one live member is left intact rather than partially rewritten.
 *
 * @param {string} text
 * @return {Array<{index: number, length: number, grouped: boolean, entries: Array<{fqn: string, alias: string}>}>}
 */
function unusedImports(text) {
    const body = textWithoutImports(text);

    return importStatements(text).filter((statement) =>
        statement.entries.every((entry) => !nameAppearsIn(body, entry.alias)),
    );
}

/** A single PHP identifier. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A namespace-separated run of identifiers, which is all an import may be. */
const QUALIFIED_NAME = /^[A-Za-z_][A-Za-z0-9_]*(?:\\[A-Za-z_][A-Za-z0-9_]*)*$/;

/**
 * Record an import, rejecting anything that is not a real qualified name.
 *
 * The check is load-bearing rather than defensive. A file with no type
 * declaration — a Laravel config returning an array, a compiled Blade view —
 * has no import block to stop at, so the statement pattern goes on to match the
 * English word "use" inside a comment and swallow everything up to the next
 * semicolon.
 *
 * @param {Array<{fqn: string, alias: string}>} imports
 * @param {string} declaration
 */
function addImport(imports, declaration) {
    const aliased = declaration.match(/^([\s\S]+?)\s+as\s+([A-Za-z_][A-Za-z0-9_]*)$/i);
    const fqn = (aliased ? aliased[1] : declaration).trim().replace(/^\\/, '');
    const alias = aliased ? aliased[2] : fqn.split('\\').pop();

    if (!QUALIFIED_NAME.test(fqn) || !IDENTIFIER.test(alias)) {
        return;
    }

    imports.push({ fqn, alias });
}

/**
 * Rewrite a fully qualified name against the longest matching import prefix.
 *
 * Returns null when no import covers the name, or when the name is already
 * imported directly and the short form therefore works as-is.
 *
 * @param {string} fqn
 * @param {Array<{fqn: string, alias: string}>} imports
 * @return {string|null}
 */
function relativize(fqn, imports) {
    let longest = null;

    for (const candidate of imports) {
        if (fqn === candidate.fqn) {
            return null;
        }

        if (!fqn.startsWith(`${candidate.fqn}\\`)) {
            continue;
        }

        if (!longest || candidate.fqn.length > longest.fqn.length) {
            longest = candidate;
        }
    }

    if (!longest) {
        return null;
    }

    return `${longest.alias}\\${fqn.slice(longest.fqn.length + 1)}`;
}

/**
 * Resolve the namespace a file must declare, from a composer PSR-4 map.
 *
 * The longest matching directory prefix wins, so a more specific mapping such
 * as `App\Domain\ => app/Domain/` beats `App\ => app/`.
 *
 * @param {string} relativePath Workspace-relative path with forward slashes, e.g. `app/Models/User.php`.
 * @param {Object<string, string|string[]>} psr4 The `autoload.psr-4` object from composer.json.
 * @return {string|null} Namespace without a trailing separator, or null when unmapped.
 */
function psr4NamespaceFor(relativePath, psr4) {
    const directory = relativePath.includes('/') ? relativePath.replace(/\/[^/]*$/, '') : '';
    let best = null;

    for (const [prefix, roots] of Object.entries(psr4 || {})) {
        for (const root of Array.isArray(roots) ? roots : [roots]) {
            const base = String(root).replace(/^\.\//, '').replace(/\/+$/, '');

            // An empty root maps the project root itself and matches every file.
            if (base !== '' && directory !== base && !directory.startsWith(`${base}/`)) {
                continue;
            }

            if (best && base.length <= best.base.length) {
                continue;
            }

            best = { base, prefix };
        }
    }

    if (!best) {
        return null;
    }

    const remainder = best.base === '' ? directory : directory.slice(best.base.length).replace(/^\//, '');
    const namespace = best.prefix.replace(/\\+$/, '');
    const suffix = remainder ? remainder.split('/').join('\\') : '';

    return suffix ? `${namespace}\\${suffix}` : namespace;
}

/**
 * The directory a namespace maps to, the inverse of {@link psr4NamespaceFor}.
 *
 * The longest matching prefix wins, matching the forward direction. When a
 * prefix lists several roots the first is used, since only composer knows which
 * of them a new file belongs in.
 *
 * @param {string} namespace
 * @param {Object<string, string|string[]>} psr4
 * @return {string|null} Workspace-relative directory, or null when unmapped.
 */
function psr4DirectoryFor(namespace, psr4) {
    let best = null;

    for (const [prefix, roots] of Object.entries(psr4 || {})) {
        const trimmed = prefix.replace(/\\+$/, '');

        if (namespace !== trimmed && !namespace.startsWith(`${trimmed}\\`)) {
            continue;
        }

        if (best && trimmed.length <= best.prefix.length) {
            continue;
        }

        const root = Array.isArray(roots) ? roots[0] : roots;

        best = { prefix: trimmed, base: String(root).replace(/^\.\//, '').replace(/\/+$/, '') };
    }

    if (!best) {
        return null;
    }

    const remainder = namespace.slice(best.prefix.length).replace(/^\\/, '');

    return [best.base, remainder ? remainder.split('\\').join('/') : ''].filter(Boolean).join('/');
}

/**
 * Locate the namespace name in a `namespace X;` or `namespace X { }` statement.
 *
 * The keyword is captured separately rather than searched for inside the match,
 * because a namespace may legitimately be called `space` and `indexOf` would
 * then find it inside the keyword itself.
 *
 * @param {string} text
 * @return {{name: string, index: number}|null} Offset of the name within `text`.
 */
function namespaceDeclaration(text) {
    const match = text.match(/^([ \t]*namespace[ \t]+)([A-Za-z_][A-Za-z0-9_\\]*)/m);

    if (!match) {
        return null;
    }

    return { name: match[2], index: match.index + match[1].length };
}

/**
 * Locate the first type declared in a file.
 *
 * @param {string} text
 * @return {string|null}
 */
function typeDeclaration(text) {
    const match = text.match(
        /^[ \t]*(?:(?:abstract|final|readonly)[ \t]+)*(?:class|interface|trait|enum)[ \t]+([A-Za-z_][A-Za-z0-9_]*)/m,
    );

    return match ? match[1] : null;
}

/**
 * Every place a fully qualified name appears in a file, with its replacement.
 *
 * Both spellings are searched: the single backslash form of source code and
 * `use` statements, and the doubled form a double-quoted PHP string requires,
 * which is how class names are written in Laravel config files.
 *
 * The boundaries are what keep this safe. A match must not continue into a
 * longer name (`App\Models\Users`), must not be the tail of a different one
 * (`Vendor\App\Models\User`), and must not be a parent of a deeper one
 * (`App\Models\User\Profile`) — while a root-qualified `\App\Models\User` must
 * still match.
 *
 * @param {string} text
 * @param {string} oldFqn
 * @param {string} newFqn
 * @param {{separators?: string[], rootQualified?: boolean}} [options] `rootQualified`
 *   allows a leading `\`, which is right for a fully qualified name and wrong
 *   for one written relative to an import, where a leading `\` would name a
 *   different class in the root namespace.
 * @return {Array<{index: number, length: number, replacement: string}>} Sorted by offset.
 */
function fqnReplacements(text, oldFqn, newFqn, options = {}) {
    const { separators = ['\\', '\\\\'], rootQualified = true } = options;
    const edits = [];

    for (const separator of separators) {
        const from = oldFqn.split('\\').join(separator);
        const to = newFqn.split('\\').join(separator);
        const literal = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const boundary = separator.replace(/\\/g, '\\\\');
        const leading = rootQualified
            ? `(?<![A-Za-z0-9_])(?<![A-Za-z0-9_]${boundary})`
            : `(?<![A-Za-z0-9_])(?<!${boundary})`;
        const pattern = new RegExp(`${leading}${literal}(?![A-Za-z0-9_\\\\])`, 'g');

        let match;
        while ((match = pattern.exec(text)) !== null) {
            edits.push({ index: match.index, length: from.length, replacement: to });
        }
    }

    return edits.sort((left, right) => left.index - right.index);
}

/**
 * The file name of a URI path, without its `.php` extension.
 *
 * @param {string} uriPath
 * @return {string}
 */
function fileBaseName(uriPath) {
    const name = uriPath.slice(uriPath.lastIndexOf('/') + 1);

    return name.endsWith('.php') ? name.slice(0, -'.php'.length) : name;
}

/**
 * Every place a bare class name appears as an identifier, with its replacement.
 *
 * Only ever applied to a file that resolves the name to the renamed class:
 * one that imports it unaliased, declares it, or shares its namespace. Even
 * there the name is skipped when it touches a quote, so a Filament block key
 * such as `'RichTextBlock'` is not rewritten along with the class.
 *
 * @param {string} text
 * @param {string} oldName
 * @param {string} newName
 * @return {Array<{index: number, length: number, replacement: string}>}
 */
function bareNameReplacements(text, oldName, newName) {
    const pattern = new RegExp(`(?<![A-Za-z0-9_$\\\\>:'"])${oldName}(?![A-Za-z0-9_'"])`, 'g');
    const edits = [];

    let match;
    while ((match = pattern.exec(text)) !== null) {
        edits.push({ index: match.index, length: oldName.length, replacement: newName });
    }

    return edits;
}

/**
 * Whether a file resolves a bare class name to the given class.
 *
 * True when it imports the class without an alias, or declares its namespace —
 * PHP resolves an unqualified name against the current namespace. An aliased
 * import is deliberately excluded: its body refers to the alias, which the
 * rename must not touch.
 *
 * @param {string} text
 * @param {{oldFqn: string, oldName: string}} rename
 * @return {boolean}
 */
function resolvesBareName(text, rename) {
    const namespace = rename.oldFqn.slice(0, rename.oldFqn.lastIndexOf('\\'));

    if (namespaceDeclaration(text)?.name === namespace) {
        return true;
    }

    return collectImports(text).some(
        (entry) => entry.fqn === rename.oldFqn && entry.alias === rename.oldName,
    );
}

/**
 * Convert a character offset into a zero-based line and character pair.
 *
 * Used to place an edit without opening the file as a text document, which
 * matters when a directory move touches hundreds of files at once.
 *
 * @param {string} text
 * @param {number} offset
 * @return {{line: number, character: number}}
 */
function offsetToPosition(text, offset) {
    let line = 0;
    let lineStart = 0;

    for (let index = 0; index < offset; index++) {
        if (text[index] === '\n') {
            line++;
            lineStart = index + 1;
        }
    }

    return { line, character: offset - lineStart };
}

/**
 * Build the fully qualified name of a workspace symbol.
 *
 * @param {vscode.SymbolInformation} symbol
 * @return {string}
 */
function fullyQualifiedName(symbol) {
    const container = (symbol.containerName || '').replace(/^\\+|\\+$/g, '');
    const name = symbol.name.replace(/^\\+/, '');

    // DEVSENSE PHP Tools returns classes with the namespace already inside
    // `name` and `containerName` empty, but repeats the namespace in both for
    // constants and methods, separated by `::` rather than `\`. Joining
    // unconditionally would duplicate it either way.
    const remainder = name.startsWith(container) ? name.slice(container.length) : null;

    if (!container || remainder === '' || remainder?.startsWith('\\') || remainder?.startsWith('::')) {
        return name;
    }

    return `${container}\\${name}`;
}

/**
 * The trailing segment of a fully qualified name.
 *
 * @param {string} fqn
 * @return {string}
 */
function shortName(fqn) {
    return fqn.split('\\').pop();
}

/**
 * Extract the bare identifier being typed, or null when the position is not a
 * place where an unqualified type name may start.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.Position} position
 * @return {string|null}
 */
function typedIdentifier(document, position) {
    const before = document.lineAt(position).text.slice(0, position.character);
    const word = before.match(/([A-Za-z_][A-Za-z0-9_]*)$/);

    if (!word) {
        return null;
    }

    const preceding = before.slice(0, before.length - word[1].length);

    // Already namespace-qualified, a member access, or a variable: the language
    // server resolves these correctly on its own.
    if (/(\\|->|\?->|::|\$)$/.test(preceding)) {
        return null;
    }

    // Inside a use statement the whole point is the fully qualified form.
    if (/^[ \t]*use[ \t]/.test(before)) {
        return null;
    }

    return word[1];
}

/** @type {vscode.CompletionItemProvider} */
const provider = {
    async provideCompletionItems(document, position, token) {
        const config = vscode.workspace.getConfiguration('phpNamespaceTools');

        if (!config.get('enabled', true)) {
            return undefined;
        }

        const word = typedIdentifier(document, position);

        if (!word || word.length < config.get('minimumPrefixLength', 3)) {
            return undefined;
        }

        const imports = collectImports(document.getText());

        if (imports.length === 0) {
            return undefined;
        }

        const symbols = await vscode.commands.executeCommand(
            'vscode.executeWorkspaceSymbolProvider',
            word,
        );

        if (token.isCancellationRequested || !Array.isArray(symbols)) {
            return undefined;
        }

        const replace = new vscode.Range(position.translate(0, -word.length), position);
        const limit = config.get('maximumSuggestions', 25);
        const seen = new Set();
        const items = [];

        for (const symbol of symbols) {
            if (items.length >= limit) {
                break;
            }

            if (!TYPE_KINDS.has(symbol.kind)) {
                continue;
            }

            const fqn = fullyQualifiedName(symbol);
            const short = shortName(fqn);

            // The symbol provider matches fuzzily across the whole project, so a
            // query for `TextInput` also returns `TestTriggeredPhpunitNotice`.
            if (!short.toLowerCase().includes(word.toLowerCase())) {
                continue;
            }

            const relative = relativize(fqn, imports);

            if (!relative || seen.has(relative)) {
                continue;
            }

            seen.add(relative);

            const item = new vscode.CompletionItem(short, vscode.CompletionItemKind.Class);
            item.detail = relative;
            item.documentation = new vscode.MarkdownString(`\`${fqn}\`\n\nInserts \`${relative}\` — no new \`use\` statement.`);
            item.insertText = relative;
            item.filterText = short;
            item.range = replace;
            item.sortText = `0${short}`;
            item.preselect = items.length === 0;

            items.push(item);
        }

        // Marked incomplete so VS Code re-queries the symbol provider on every
        // keystroke. Otherwise it caches this list and filters it locally, and a
        // longer prefix never reaches the language server.
        return new vscode.CompletionList(items, true);
    },
};

/**
 * Dump raw workspace symbol results so the underlying language server's output
 * can be inspected. This is the assumption the whole extension rests on.
 *
 * @param {vscode.OutputChannel} output
 */
async function debugSymbols(output) {
    const query = await vscode.window.showInputBox({
        prompt: 'Workspace symbol query',
        placeHolder: 'TextInput',
    });

    if (!query) {
        return;
    }

    const symbols = await vscode.commands.executeCommand(
        'vscode.executeWorkspaceSymbolProvider',
        query,
    );

    output.clear();
    output.appendLine(`query: ${query}`);
    output.appendLine(`results: ${Array.isArray(symbols) ? symbols.length : 'none'}`);
    output.appendLine('');

    for (const symbol of (symbols || []).slice(0, 60)) {
        output.appendLine(
            [
                fullyQualifiedName(symbol).padEnd(70),
                `kind=${vscode.SymbolKind[symbol.kind]}`.padEnd(18),
                `container=${JSON.stringify(symbol.containerName)}`,
            ].join(' '),
        );
    }

    const editor = vscode.window.activeTextEditor;

    if (editor && editor.document.languageId === 'php') {
        output.appendLine('');
        output.appendLine('imports in active document:');
        for (const entry of collectImports(editor.document.getText())) {
            output.appendLine(`  ${entry.alias.padEnd(24)} -> ${entry.fqn}`);
        }

        await probeRenameFoundations(output, editor);
    }

    output.show(true);
}

/**
 * Probe the two capabilities a rename/move refactoring would be built on: the
 * reference provider, and a readable composer PSR-4 map.
 *
 * @param {vscode.OutputChannel} output
 * @param {vscode.TextEditor} editor
 */
async function probeRenameFoundations(output, editor) {
    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);

    output.appendLine('');
    output.appendLine('--- rename/move foundations ---');

    if (!folder) {
        output.appendLine('no workspace folder for the active document');
        return;
    }

    const relative = vscode.workspace.asRelativePath(editor.document.uri, false);

    try {
        const composerUri = vscode.Uri.joinPath(folder.uri, 'composer.json');
        const raw = await vscode.workspace.fs.readFile(composerUri);
        const composer = JSON.parse(Buffer.from(raw).toString('utf8'));
        const psr4 = (composer.autoload || {})['psr-4'] || {};

        output.appendLine(`composer psr-4: ${JSON.stringify(psr4)}`);
        output.appendLine(`path:           ${relative}`);
        output.appendLine(`derived ns:     ${psr4NamespaceFor(relative, psr4)}`);

        const declared = editor.document.getText().match(/^[ \t]*namespace[ \t]+([^;]+);/m);
        output.appendLine(`declared ns:    ${declared ? declared[1].trim() : '(none)'}`);
    } catch (error) {
        output.appendLine(`composer.json unreadable: ${error.message}`);
    }

    const references = await vscode.commands.executeCommand(
        'vscode.executeReferenceProvider',
        editor.document.uri,
        editor.selection.active,
    );

    output.appendLine(
        `reference provider at cursor: ${Array.isArray(references) ? `${references.length} hit(s)` : 'no provider'}`,
    );

    for (const reference of (references || []).slice(0, 10)) {
        output.appendLine(
            `  ${vscode.workspace.asRelativePath(reference.uri, false)}:${reference.range.start.line + 1}`,
        );
    }
}

/**
 * Read the merged PSR-4 map of a workspace folder.
 *
 * `autoload` is applied over `autoload-dev` so a prefix declared in both wins
 * from the non-dev section, matching how composer builds its classmap.
 *
 * @param {vscode.WorkspaceFolder} folder
 * @return {Promise<Object<string, string|string[]>|null>}
 */
async function readPsr4(folder) {
    try {
        const raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, 'composer.json'));
        const composer = JSON.parse(Buffer.from(raw).toString('utf8'));

        return {
            ...((composer['autoload-dev'] || {})['psr-4'] || {}),
            ...((composer.autoload || {})['psr-4'] || {}),
        };
    } catch {
        return null;
    }
}

/** Directories never worth descending into when a folder is moved. */
const SKIPPED_DIRECTORIES = new Set(['vendor', 'node_modules']);

/**
 * Every `.php` file at or below a URI, as {@link vscode.Uri} values.
 *
 * The directory tree is walked directly rather than through `findFiles`, whose
 * results are filtered by the user's search excludes — a file silently skipped
 * here would keep a namespace that no longer autoloads.
 *
 * @param {vscode.Uri} uri
 * @return {Promise<vscode.Uri[]>}
 */
async function phpFilesUnder(uri) {
    let entries;

    try {
        entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
        return uri.path.endsWith('.php') ? [uri] : [];
    }

    const found = [];

    for (const [name, type] of entries) {
        const child = vscode.Uri.joinPath(uri, name);

        if (type === vscode.FileType.Directory) {
            if (SKIPPED_DIRECTORIES.has(name) || name.startsWith('.')) {
                continue;
            }

            found.push(...(await phpFilesUnder(child)));
        } else if (name.endsWith('.php')) {
            found.push(child);
        }
    }

    return found;
}

/**
 * Expand one reported rename into the individual PHP files it moves.
 *
 * VS Code reports a directory move as a single rename of the directory, so the
 * children have to be enumerated to be renamespaced.
 *
 * @param {vscode.Uri} oldUri
 * @param {vscode.Uri} newUri
 * @return {Promise<Array<{oldUri: vscode.Uri, newUri: vscode.Uri}>>}
 */
async function expandMove(oldUri, newUri) {
    const files = await phpFilesUnder(oldUri);

    return files.map((file) => ({
        oldUri: file,
        newUri: newUri.with({ path: newUri.path + file.path.slice(oldUri.path.length) }),
    }));
}

/**
 * Rewrite the `namespace` declaration of each PHP file being moved so it keeps
 * matching its PSR-4 directory.
 *
 * The edits target the old locations: VS Code applies them before performing the
 * rename. Only the moved files themselves are touched — imports of them elsewhere
 * in the project are left alone, and the language server reports them as
 * unresolved.
 *
 * @param {ReadonlyArray<{oldUri: vscode.Uri, newUri: vscode.Uri}>} files
 * @param {vscode.OutputChannel} output
 * @return {Promise<vscode.WorkspaceEdit>}
 */
async function namespaceUpdatesForMove(files, output) {
    const edit = new vscode.WorkspaceEdit();
    const moves = [];

    for (const { oldUri, newUri } of files) {
        moves.push(...(await expandMove(oldUri, newUri)));
    }

    const configuration = vscode.workspace.getConfiguration('phpNamespaceTools');
    const limit = configuration.get('maximumFilesPerMove', 500);

    if (moves.length > limit) {
        output.appendLine(
            `move touches ${moves.length} PHP files, above the ${limit} file limit — nothing was updated`,
        );
        output.show(true);

        return edit;
    }

    const renames = [];

    for (const { oldUri, newUri } of moves) {
        const folder = vscode.workspace.getWorkspaceFolder(newUri) ?? vscode.workspace.getWorkspaceFolder(oldUri);

        if (!folder) {
            continue;
        }

        const psr4 = await readPsr4(folder);
        const target = psr4 && psr4NamespaceFor(vscode.workspace.asRelativePath(newUri, false), psr4);

        if (!target) {
            continue;
        }

        const text = Buffer.from(await vscode.workspace.fs.readFile(oldUri)).toString('utf8');
        const declaration = namespaceDeclaration(text);

        if (!declaration) {
            continue;
        }

        const type = typeDeclaration(text);
        const oldBase = fileBaseName(oldUri.path);
        const newBase = fileBaseName(newUri.path);

        // The type is only renamed when it was named after its file, which is
        // what PSR-4 requires. A file holding a differently named class is
        // being moved, not renamed.
        const renamedType = type === oldBase && newBase !== oldBase ? newBase : type;
        const movedNamespace = declaration.name !== target;

        if (!movedNamespace && renamedType === type) {
            continue;
        }

        if (movedNamespace) {
            replaceOffset(edit, oldUri, text, declaration.index, declaration.name.length, target);
            output.appendLine(`${vscode.workspace.asRelativePath(oldUri, false)}: ${declaration.name} -> ${target}`);
        }

        if (!type) {
            continue;
        }

        if (renamedType !== type) {
            output.appendLine(`${vscode.workspace.asRelativePath(oldUri, false)}: class ${type} -> ${renamedType}`);
        }

        renames.push({
            oldFqn: `${declaration.name}\\${type}`,
            newFqn: `${target}\\${renamedType}`,
            oldName: type,
            newName: renamedType,
        });
    }

    if (renames.length > 0 && configuration.get('updateImportsOnMove', true)) {
        await updateReferences(edit, renames, output);
    }

    return edit;
}

/**
 * Queue a replacement described by a character offset into `text`.
 *
 * @param {vscode.WorkspaceEdit} edit
 * @param {vscode.Uri} uri
 * @param {string} text
 * @param {number} index
 * @param {number} length
 * @param {string} replacement
 */
function replaceOffset(edit, uri, text, index, length, replacement) {
    const start = offsetToPosition(text, index);
    const end = offsetToPosition(text, index + length);

    edit.replace(
        uri,
        new vscode.Range(
            new vscode.Position(start.line, start.character),
            new vscode.Position(end.line, end.character),
        ),
        replacement,
    );
}

/**
 * Repoint every reference to a moved class at its new fully qualified name.
 *
 * Matching is textual on the full name rather than driven by the reference
 * provider, which covers `use` statements, `::class` expressions and the plain
 * strings Laravel configuration uses to name classes — the last of which no
 * PHP language server resolves.
 *
 * Candidate files come from `findFiles`, so a path hidden by the user's
 * `files.exclude` or `search.exclude` is not visited.
 *
 * @param {vscode.WorkspaceEdit} edit
 * @param {Array<{oldFqn: string, newFqn: string}>} renames
 * @param {vscode.OutputChannel} output
 */
async function updateReferences(edit, renames, output) {
    // Cheap pre-filter so most files are rejected on a substring test rather
    // than a regex per rename. The short name is the one thing every spelling
    // of a reference contains — fully qualified, partially qualified against an
    // imported namespace, or bare — so rejecting on it cannot lose a match.
    const needles = [...new Set(renames.map(({ oldName }) => oldName))];

    const candidates = await vscode.workspace.findFiles('**/*.php', '**/{vendor,node_modules}/**');
    let files = 0;
    let references = 0;

    for (const uri of candidates) {
        const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

        if (!needles.some((needle) => text.includes(needle))) {
            continue;
        }

        const imports = collectImports(text);
        let found = 0;

        const apply = (occurrences) => {
            for (const occurrence of occurrences) {
                replaceOffset(edit, uri, text, occurrence.index, occurrence.length, occurrence.replacement);
                found++;
            }
        };

        for (const rename of renames) {
            apply(fqnReplacements(text, rename.oldFqn, rename.newFqn));

            // A name written against an imported parent namespace, such as
            // `PageBlocks\About\CompanyInfoBlock` under `use App\Filament\PageBlocks;`.
            // Neither the fully qualified nor the bare pass can see it.
            const oldRelative = relativize(rename.oldFqn, imports);

            if (oldRelative) {
                // Once moved out from under that import there is no relative
                // spelling left, so fall back to a root-qualified name — an
                // unqualified one would resolve against the current namespace.
                const newRelative = relativize(rename.newFqn, imports) ?? `\\${rename.newFqn}`;

                if (newRelative !== oldRelative) {
                    apply(
                        fqnReplacements(text, oldRelative, newRelative, {
                            separators: ['\\'],
                            rootQualified: false,
                        }),
                    );
                }
            }

            // A renamed class also has to be repointed where the file refers to
            // it by its bare name, which neither pass above can see.
            if (rename.oldName === rename.newName || !resolvesBareName(text, rename)) {
                continue;
            }

            apply(bareNameReplacements(text, rename.oldName, rename.newName));
        }

        if (found > 0) {
            files++;
            references += found;
            output.appendLine(`  ${vscode.workspace.asRelativePath(uri, false)}: ${found} reference(s)`);
        }
    }

    output.appendLine(`repointed ${references} reference(s) across ${files} file(s)`);
    output.show(true);
}

/**
 * Set while this extension performs a rename itself, so the rename participant
 * does not compute the same edits a second time on top of its own.
 */
let performingOwnRename = false;

/**
 * Move PHP files, rewriting namespaces and references in the same edit.
 *
 * The text edits are queued before the rename so VS Code applies them while the
 * files are still at their old paths, and the whole thing lands as one undo
 * step.
 *
 * @param {Array<{oldUri: vscode.Uri, newUri: vscode.Uri}>} pairs
 * @param {vscode.OutputChannel} output
 * @return {Promise<boolean>}
 */
async function performMove(pairs, output) {
    const edit = await namespaceUpdatesForMove(pairs, output);

    for (const { oldUri, newUri } of pairs) {
        await vscode.workspace.fs.createDirectory(newUri.with({ path: newUri.path.replace(/\/[^/]*$/, '') }));
        edit.renameFile(oldUri, newUri, { overwrite: false });
    }

    performingOwnRename = true;

    try {
        return await vscode.workspace.applyEdit(edit);
    } finally {
        performingOwnRename = false;
    }
}

/**
 * The active PHP file, saved and parsed, or null with the reason reported.
 *
 * @return {Promise<{document: vscode.TextDocument, folder: vscode.WorkspaceFolder, psr4: Object, declaration: {name: string, index: number}, type: string|null}|null>}
 */
async function activePhpFile() {
    const editor = vscode.window.activeTextEditor;

    if (!editor || editor.document.languageId !== 'php' || editor.document.uri.scheme !== 'file') {
        vscode.window.showWarningMessage('Open a PHP file first.');

        return null;
    }

    // The move pipeline reads files from disk, so unsaved edits would be lost.
    if (editor.document.isDirty && !(await editor.document.save())) {
        vscode.window.showWarningMessage('Save the file first.');

        return null;
    }

    const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const psr4 = folder && (await readPsr4(folder));

    if (!psr4) {
        vscode.window.showWarningMessage('No composer.json with a PSR-4 autoload map was found.');

        return null;
    }

    const declaration = namespaceDeclaration(editor.document.getText());

    if (!declaration) {
        vscode.window.showWarningMessage('This file declares no namespace.');

        return null;
    }

    return {
        document: editor.document,
        folder,
        psr4,
        declaration,
        type: typeDeclaration(editor.document.getText()),
    };
}

/**
 * Move the active class to another namespace, asking for the target.
 *
 * The namespace is asked for rather than the directory: PSR-4 maps the two onto
 * each other, and the namespace is what the code actually refers to.
 *
 * @param {vscode.OutputChannel} output
 */
async function moveClassCommand(output) {
    const context = await activePhpFile();

    if (!context) {
        return;
    }

    const target = await vscode.window.showInputBox({
        title: 'Move class to namespace',
        value: context.declaration.name,
        valueSelection: [context.declaration.name.lastIndexOf('\\') + 1, context.declaration.name.length],
        prompt: 'The directory is derived from the composer PSR-4 map.',
        validateInput: (value) => {
            const trimmed = value.trim().replace(/^\\/, '');

            if (!QUALIFIED_NAME.test(trimmed)) {
                return 'Not a valid namespace.';
            }

            return psr4DirectoryFor(trimmed, context.psr4) ? null : 'No PSR-4 root covers that namespace.';
        },
    });

    if (!target) {
        return;
    }

    const directory = psr4DirectoryFor(target.trim().replace(/^\\/, ''), context.psr4);
    const name = context.document.uri.path.slice(context.document.uri.path.lastIndexOf('/') + 1);
    const newUri = vscode.Uri.joinPath(context.folder.uri, directory, name);

    if (newUri.path === context.document.uri.path) {
        return;
    }

    await performMove([{ oldUri: context.document.uri, newUri }], output);
}

/**
 * Rename the active class and its file together.
 *
 * @param {vscode.OutputChannel} output
 */
async function renameClassCommand(output) {
    const context = await activePhpFile();

    if (!context) {
        return;
    }

    if (!context.type) {
        vscode.window.showWarningMessage('This file declares no class, interface, trait or enum.');

        return;
    }

    const target = await vscode.window.showInputBox({
        title: `Rename ${context.type}`,
        value: context.type,
        prompt: 'The file is renamed to match, and references are repointed.',
        validateInput: (value) => (IDENTIFIER.test(value.trim()) ? null : 'Not a valid class name.'),
    });

    if (!target || target.trim() === context.type) {
        return;
    }

    const path = context.document.uri.path;
    const newUri = context.document.uri.with({
        path: `${path.slice(0, path.lastIndexOf('/'))}/${target.trim()}.php`,
    });

    await performMove([{ oldUri: context.document.uri, newUri }], output);
}

/** Marks a diagnostic this extension knows how to fix. */
const NAMESPACE_MISMATCH = 'phpNamespaceTools.namespaceMismatch';
const UNUSED_IMPORT = 'phpNamespaceTools.unusedImport';

/**
 * Report a namespace that no longer matches its PSR-4 directory, and imports
 * that nothing in the file refers to.
 *
 * A file moved outside the editor — by git, by `mv`, by a merge — never raises
 * a rename event, so this is the only thing that catches it.
 *
 * @param {vscode.TextDocument} document
 * @param {vscode.DiagnosticCollection} diagnostics
 */
async function refreshDiagnostics(document, diagnostics) {
    if (document.languageId !== 'php' || document.uri.scheme !== 'file') {
        return;
    }

    const configuration = vscode.workspace.getConfiguration('phpNamespaceTools');
    const found = [];
    const text = document.getText();

    if (configuration.get('reportNamespaceMismatch', true)) {
        const folder = vscode.workspace.getWorkspaceFolder(document.uri);
        const psr4 = folder && (await readPsr4(folder));
        const expected = psr4 && psr4NamespaceFor(vscode.workspace.asRelativePath(document.uri, false), psr4);
        const declaration = namespaceDeclaration(text);

        if (expected && declaration && declaration.name !== expected) {
            const diagnostic = new vscode.Diagnostic(
                rangeOfOffset(document, declaration.index, declaration.name.length),
                `Namespace does not match its PSR-4 directory. Expected ${expected}.`,
                vscode.DiagnosticSeverity.Warning,
            );

            diagnostic.code = NAMESPACE_MISMATCH;
            diagnostic.source = 'PHP Namespace Tools';
            found.push(diagnostic);
        }
    }

    if (configuration.get('reportUnusedImports', true)) {
        for (const statement of unusedImports(text)) {
            const names = statement.entries.map((entry) => entry.alias).join(', ');
            const diagnostic = new vscode.Diagnostic(
                rangeOfOffset(document, statement.index, statement.length),
                `Import is never used: ${names}.`,
                vscode.DiagnosticSeverity.Hint,
            );

            diagnostic.code = UNUSED_IMPORT;
            diagnostic.source = 'PHP Namespace Tools';
            diagnostic.tags = [vscode.DiagnosticTag.Unnecessary];
            found.push(diagnostic);
        }
    }

    diagnostics.set(document.uri, found);
}

/**
 * @param {vscode.TextDocument} document
 * @param {number} index
 * @param {number} length
 * @return {vscode.Range}
 */
function rangeOfOffset(document, index, length) {
    return new vscode.Range(document.positionAt(index), document.positionAt(index + length));
}

/**
 * The range covering an import statement and the line break after it, so
 * removing it does not leave a blank line behind.
 *
 * @param {vscode.TextDocument} document
 * @param {{index: number, length: number}} statement
 * @return {vscode.Range}
 */
function importRemovalRange(document, statement) {
    const range = rangeOfOffset(document, statement.index, statement.length);
    const line = document.lineAt(range.start.line);

    // Only swallow the line break when the statement is alone on its line;
    // `use A; use B;` must lose one statement, not the whole line.
    return line.text.trim() === document.getText(range).trim() ? line.rangeIncludingLineBreak : range;
}

/** Quick fixes for the diagnostics above, plus Organize Imports. */
const codeActions = {
    async provideCodeActions(document, range, context) {
        const actions = [];
        const text = document.getText();

        for (const diagnostic of context.diagnostics) {
            if (diagnostic.code !== NAMESPACE_MISMATCH) {
                continue;
            }

            const expected = diagnostic.message.match(/Expected (.+)\.$/)?.[1];
            const declaration = namespaceDeclaration(text);

            if (!expected || !declaration) {
                continue;
            }

            const action = new vscode.CodeAction(
                `Change namespace to ${expected}`,
                vscode.CodeActionKind.QuickFix,
            );

            action.diagnostics = [diagnostic];
            action.edit = new vscode.WorkspaceEdit();
            action.edit.replace(document.uri, diagnostic.range, expected);

            const type = typeDeclaration(text);

            if (type) {
                await updateReferences(
                    action.edit,
                    [
                        {
                            oldFqn: `${declaration.name}\\${type}`,
                            newFqn: `${expected}\\${type}`,
                            oldName: type,
                            newName: type,
                        },
                    ],
                    { appendLine() {}, show() {} },
                );
            }

            actions.push(action);
        }

        const unused = unusedImports(text);

        if (unused.length > 0) {
            const organize = new vscode.CodeAction(
                `Remove ${unused.length} unused import${unused.length === 1 ? '' : 's'}`,
                vscode.CodeActionKind.SourceOrganizeImports,
            );

            organize.edit = new vscode.WorkspaceEdit();

            for (const statement of unused) {
                organize.edit.delete(document.uri, importRemovalRange(document, statement));
            }

            actions.push(organize);
        }

        return actions;
    },
};

/** @param {vscode.ExtensionContext} context */
function activate(context) {
    const output = vscode.window.createOutputChannel('PHP Namespace Tools');
    const diagnostics = vscode.languages.createDiagnosticCollection('phpNamespaceTools');
    const refresh = (document) => refreshDiagnostics(document, diagnostics);

    context.subscriptions.push(
        output,
        diagnostics,
        vscode.languages.registerCompletionItemProvider({ language: 'php', scheme: 'file' }, provider),
        vscode.languages.registerCodeActionsProvider({ language: 'php', scheme: 'file' }, codeActions, {
            providedCodeActionKinds: [
                vscode.CodeActionKind.QuickFix,
                vscode.CodeActionKind.SourceOrganizeImports,
            ],
        }),
        vscode.commands.registerCommand('phpNamespaceTools.debugSymbols', () => debugSymbols(output)),
        vscode.commands.registerCommand('phpNamespaceTools.moveClass', () => moveClassCommand(output)),
        vscode.commands.registerCommand('phpNamespaceTools.renameClass', () => renameClassCommand(output)),
        vscode.workspace.onWillRenameFiles((event) => {
            if (performingOwnRename) {
                return;
            }

            if (vscode.workspace.getConfiguration('phpNamespaceTools').get('updateNamespaceOnMove', true)) {
                event.waitUntil(namespaceUpdatesForMove(event.files, output));
            }
        }),
        vscode.workspace.onDidOpenTextDocument(refresh),
        vscode.workspace.onDidSaveTextDocument(refresh),
        vscode.workspace.onDidCloseTextDocument((document) => diagnostics.delete(document.uri)),
    );

    vscode.workspace.textDocuments.forEach(refresh);
}

function deactivate() {}

module.exports = {
    activate,
    deactivate,
    collectImports,
    importStatements,
    isNameUsed,
    unusedImports,
    maskLiterals,
    relativize,
    fullyQualifiedName,
    shortName,
    psr4NamespaceFor,
    psr4DirectoryFor,
    namespaceDeclaration,
    typeDeclaration,
    fqnReplacements,
    bareNameReplacements,
    resolvesBareName,
    fileBaseName,
    offsetToPosition,
};

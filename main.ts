// mend — one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patch, text-editor JSON), finds the lines it names even when line
// numbers, whitespace or indentation have drifted, and applies every edit
// or none of them. The behaviour is SPEC.md, sentence by sentence.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

type FailCode = 'no-match' | 'ambiguous' | 'missing' | 'exists' | 'unsafe';

class ParseFail extends Error {
  line: number;
  constructor(line: number) {
    super('parse ' + line);
    this.line = line;
  }
}

class EditFail extends Error {
  code: FailCode;
  path: string;
  constructor(code: FailCode, path: string) {
    super(code + ' ' + path);
    this.code = code;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Files as lines (SPEC section 3)
// ---------------------------------------------------------------------------

type FileState = { lines: string[]; brk: string; finalBreak: boolean };

function parseFileText(text: string): FileState {
  if (text === '') return { lines: [], brk: '\n', finalBreak: false };
  const nl = text.indexOf('\n');
  const brk = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBreak = text.endsWith(brk);
  const parts = text.split(brk);
  if (finalBreak) parts.pop();
  return { lines: parts, brk, finalBreak };
}

function renderFileText(st: FileState): string {
  if (st.lines.length === 0) return '';
  return st.lines.join(st.brk) + (st.finalBreak ? st.brk : '');
}

function patchLinesOf(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts.map((p) => (p.endsWith('\r') ? p.slice(0, -1) : p));
}

function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function requireSafe(p: string): void {
  if (!isSafePath(p)) throw new EditFail('unsafe', p);
}

// The tree of files: originals read lazily from disk, edits applied to an
// in-memory overlay so a failed edit (or a failed patch) changes nothing.
class Tree {
  origCache = new Map<string, string | null>();
  now = new Map<string, string | null>();

  original(p: string): string | null {
    if (!this.origCache.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.origCache.set(p, v);
    }
    return this.origCache.get(p) as string | null;
  }

  get(p: string): string | null {
    return this.now.has(p) ? (this.now.get(p) as string | null) : this.original(p);
  }

  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }

  touched(): string[] {
    return [...this.now.keys()];
  }

  snapshot(): Map<string, string | null> {
    return new Map(this.now);
  }

  restore(s: Map<string, string | null>): void {
    this.now = new Map(s);
  }
}

// ---------------------------------------------------------------------------
// Matching lines at three tiers (SPEC section 5)
// ---------------------------------------------------------------------------

function stripTrailingWs(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function stripLeadingWs(s: string): string {
  return s.replace(/^[ \t]+/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

function tierForm(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return stripTrailingWs(s);
  return stripLeadingWs(stripTrailingWs(s));
}

// One old line of an edit. `ctx` marks a context line (present in both O and N).
type OLine = { text: string; ctx: boolean };
// One new line. For a context line, `oIndex` is its position within O.
type NLine = { text: string; ctx: boolean; oIndex: number };

function occurrencesAt(fileLines: string[], o: OLine[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > fileLines.length) return out;
  const oForms = o.map((l) => tierForm(l.text, tier));
  const fForms = fileLines.map((l) => tierForm(l, tier));
  for (let i = 0; i + o.length <= fileLines.length; i++) {
    let ok = true;
    for (let k = 0; k < o.length; k++) {
      if (fForms[i + k] !== oForms[k]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// The first tier at which O occurs, counting only occurrences `accept` allows.
function findTier(
  fileLines: string[],
  o: OLine[],
  strict: boolean,
  accept: (pos: number) => boolean,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrencesAt(fileLines, o, tier).filter(accept);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// The lines written in place of a match: context lines as the file's own,
// other lines as written — re-indented at tier 2 (SPEC section 5).
function buildReplacement(
  fileLines: string[],
  matchPos: number,
  o: OLine[],
  n: NLine[],
  tier: number,
): string[] {
  const out: string[] = [];
  const F = leadingWs(fileLines[matchPos]);
  const P = leadingWs(o[0].text);
  for (const nl of n) {
    if (nl.ctx) {
      out.push(fileLines[matchPos + nl.oIndex]);
    } else if (tier === 2 && nl.text.trim() !== '' && nl.text.startsWith(P)) {
      out.push(F + nl.text.slice(P.length));
    } else {
      out.push(nl.text);
    }
  }
  return out;
}

function spliceLines(lines: string[], pos: number, remove: number, insert: string[]): string[] {
  return [...lines.slice(0, pos), ...insert, ...lines.slice(pos + remove)];
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC section 6)
// ---------------------------------------------------------------------------

type UBodyLine = { kind: 'ctx' | 'del' | 'add' | 'bs'; text: string; fromEmpty: boolean };
type UHunk = { a: number; c: number; body: UBodyLine[] };
type USection = {
  gitOld: string | null;
  gitNew: string | null;
  oldNamed: boolean;
  oldPath: string | null; // null means /dev/null when named
  newNamed: boolean;
  newPath: string | null;
  renOld: string | null;
  renNew: string | null;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: UHunk[];
};

function parseUnified(lines: string[]): USection[] {
  const sections: USection[] = [];
  let sec: USection | null = null;
  let inHeader = false;
  let i = 0;

  const isGitLine = (l: string) => l === 'diff --git' || l.startsWith('diff --git ');
  const isDashPair = (idx: number) =>
    lines[idx].startsWith('--- ') && idx + 1 < lines.length && lines[idx + 1].startsWith('+++ ');

  function newSection(): USection {
    const s: USection = {
      gitOld: null,
      gitNew: null,
      oldNamed: false,
      oldPath: null,
      newNamed: false,
      newPath: null,
      renOld: null,
      renNew: null,
      newFileMode: false,
      deletedFileMode: false,
      hunks: [],
    };
    sections.push(s);
    inHeader = true;
    return s;
  }

  function headerPath(l: string): string | null {
    let t = l.slice(4);
    const tab = t.indexOf('\t');
    if (tab >= 0) t = t.slice(0, tab);
    t = t.trim();
    if (t === '/dev/null') return null;
    if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
    return t;
  }

  while (i < lines.length) {
    const l = lines[i];
    if (isGitLine(l)) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (!m) throw new ParseFail(i + 1);
      sec = newSection();
      sec.gitOld = m[1];
      sec.gitNew = m[2];
      i++;
      continue;
    }
    if (l.startsWith('--- ')) {
      if (isDashPair(i)) {
        if (!(sec && inHeader)) sec = newSection();
        (sec as USection).oldNamed = true;
        (sec as USection).oldPath = headerPath(l);
        (sec as USection).newNamed = true;
        (sec as USection).newPath = headerPath(lines[i + 1]);
        i += 2;
        continue;
      }
      if (sec && inHeader) throw new ParseFail(i + 2);
      i++; // prose outside a section header
      continue;
    }
    if (l.startsWith('@@')) {
      if (!sec) throw new ParseFail(i + 1);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (!m) throw new ParseFail(i + 1);
      inHeader = false;
      const hunk: UHunk = { a: Number(m[1]), c: Number(m[2]), body: [] };
      sec.hunks.push(hunk);
      i++;
      while (i < lines.length) {
        const b = lines[i];
        if (isGitLine(b) || isDashPair(i)) break;
        if (b === '') {
          hunk.body.push({ kind: 'ctx', text: '', fromEmpty: true });
          i++;
          continue;
        }
        const ch = b[0];
        if (ch === ' ') hunk.body.push({ kind: 'ctx', text: b.slice(1), fromEmpty: false });
        else if (ch === '-') hunk.body.push({ kind: 'del', text: b.slice(1), fromEmpty: false });
        else if (ch === '+') hunk.body.push({ kind: 'add', text: b.slice(1), fromEmpty: false });
        else if (ch === '\\') hunk.body.push({ kind: 'bs', text: b.slice(1), fromEmpty: false });
        else break;
        i++;
      }
      // Empty lines at the end of a body are not part of it.
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1].fromEmpty) hunk.body.pop();
      continue;
    }
    if (sec && inHeader) {
      if (l.startsWith('+++ ')) {
        sec.newNamed = true;
        sec.newPath = headerPath(l);
      } else if (l.startsWith('rename from ')) {
        sec.renOld = l.slice('rename from '.length).trim();
      } else if (l.startsWith('rename to ')) {
        sec.renNew = l.slice('rename to '.length).trim();
      } else if (l.startsWith('new file mode')) {
        sec.newFileMode = true;
      } else if (l.startsWith('deleted file mode')) {
        sec.deletedFileMode = true;
      }
      i++;
      continue;
    }
    i++; // prose and code fences outside bodies are ignored
  }
  return sections;
}

function applyUnifiedHunks(
  st: FileState,
  hunks: UHunk[],
  strict: boolean,
  errPath: string,
): FileState {
  let lines = st.lines;
  let finalBreak = st.finalBreak;
  let d = 0;
  for (const h of hunks) {
    const o: OLine[] = [];
    const n: NLine[] = [];
    for (const b of h.body) {
      if (b.kind === 'ctx') {
        const oIndex = o.length;
        o.push({ text: b.text, ctx: true });
        n.push({ text: b.text, ctx: true, oIndex });
      } else if (b.kind === 'del') {
        o.push({ text: b.text, ctx: false });
      } else if (b.kind === 'add') {
        n.push({ text: b.text, ctx: false, oIndex: -1 });
      }
    }
    // Does a `\` line follow the hunk's last context or `+` line?
    let bsAfterLast = false;
    for (let k = h.body.length - 1; k >= 0; k--) {
      const bk = h.body[k].kind;
      if (bk === 'ctx' || bk === 'add') {
        bsAfterLast = k + 1 < h.body.length && h.body[k + 1].kind === 'bs';
        break;
      }
    }
    if (o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > lines.length) pos = lines.length;
      const atEnd = pos === lines.length;
      lines = spliceLines(lines, pos, 0, n.map((x) => x.text));
      if (atEnd) finalBreak = !bsAfterLast;
    } else {
      const found = findTier(lines, o, strict, () => true);
      if (!found) throw new EditFail('no-match', errPath);
      const target = h.a - 1 + d;
      let best = found.positions[0];
      for (const p of found.positions) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const atEnd = best + o.length === lines.length;
      const repl = buildReplacement(lines, best, o, n, found.tier);
      lines = spliceLines(lines, best, o.length, repl);
      if (atEnd) finalBreak = !bsAfterLast;
    }
    d += n.length - o.length;
  }
  return { lines, brk: st.brk, finalBreak };
}

function applyUnifiedSection(
  tree: Tree,
  sec: USection,
  strict: boolean,
  moves: { old: string; new: string }[],
): void {
  const oldPath: string | null = sec.oldNamed ? sec.oldPath : (sec.renOld ?? sec.gitOld);
  const newPath: string | null = sec.newNamed ? sec.newPath : (sec.renNew ?? sec.gitNew);
  const creation = oldPath === null || sec.newFileMode;
  const deletion = !creation && (newPath === null || sec.deletedFileMode);

  if (creation) {
    if (newPath === null) throw new EditFail('unsafe', '/dev/null');
    requireSafe(newPath);
    if (tree.get(newPath) !== null) throw new EditFail('exists', newPath);
    const flines: string[] = [];
    let lastAddBs = false;
    for (const h of sec.hunks) {
      for (let k = 0; k < h.body.length; k++) {
        if (h.body[k].kind === 'add') {
          flines.push(h.body[k].text);
          lastAddBs = k + 1 < h.body.length && h.body[k + 1].kind === 'bs';
        }
      }
    }
    tree.set(newPath, renderFileText({ lines: flines, brk: '\n', finalBreak: !lastAddBs }));
    return;
  }

  if (deletion) {
    if (oldPath === null) throw new EditFail('unsafe', '/dev/null');
    requireSafe(oldPath);
    if (tree.get(oldPath) === null) throw new EditFail('missing', oldPath);
    tree.set(oldPath, null);
    return;
  }

  const op = oldPath as string;
  const np = newPath as string;
  requireSafe(op);
  requireSafe(np);
  const cur = tree.get(op);
  if (cur === null) throw new EditFail('missing', op);
  const isMove = op !== np;
  if (isMove && tree.get(np) !== null) throw new EditFail('exists', np);
  const st = parseFileText(cur);
  const out = applyUnifiedHunks(st, sec.hunks, strict, op);
  tree.set(np, renderFileText(out));
  if (isMove) {
    tree.set(op, null);
    moves.push({ old: op, new: np });
  }
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC section 7)
// ---------------------------------------------------------------------------

type SREdit = { path: string; oldLines: string[]; newLines: string[] };

function parseSearchReplace(lines: string[]): SREdit[] {
  const edits: SREdit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0; // first line after the previous block's REPLACE line
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= searchFrom; j--) {
      const t = lines[j].trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseFail(searchLine + 1);
      path = prevPath;
    }
    const oldLines: string[] = [];
    i++;
    let sawEq = false;
    while (i < lines.length) {
      const t = lines[i].trimEnd();
      if (t === '=======') {
        sawEq = true;
        i++;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
      oldLines.push(lines[i]);
      i++;
    }
    if (!sawEq) throw new ParseFail(searchLine + 1);
    const newLines: string[] = [];
    let sawRep = false;
    while (i < lines.length) {
      const t = lines[i].trimEnd();
      if (t === '>>>>>>> REPLACE') {
        sawRep = true;
        i++;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
      newLines.push(lines[i]);
      i++;
    }
    if (!sawRep) throw new ParseFail(searchLine + 1);
    edits.push({ path, oldLines, newLines });
    prevPath = path;
    searchFrom = i;
  }
  return edits;
}

function applySR(tree: Tree, e: SREdit, strict: boolean): void {
  requireSafe(e.path);
  const cur = tree.get(e.path);
  if (e.oldLines.length === 0) {
    if (cur !== null) throw new EditFail('exists', e.path);
    tree.set(e.path, renderFileText({ lines: e.newLines, brk: '\n', finalBreak: true }));
    return;
  }
  if (cur === null) throw new EditFail('missing', e.path);
  const st = parseFileText(cur);
  const o: OLine[] = e.oldLines.map((t) => ({ text: t, ctx: false }));
  const found = findTier(st.lines, o, strict, () => true);
  if (!found) throw new EditFail('no-match', e.path);
  if (found.positions.length > 1) throw new EditFail('ambiguous', e.path);
  const n: NLine[] = e.newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
  const repl = buildReplacement(st.lines, found.positions[0], o, n, found.tier);
  const lines = spliceLines(st.lines, found.positions[0], o.length, repl);
  tree.set(e.path, renderFileText({ lines, brk: st.brk, finalBreak: st.finalBreak }));
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC section 8)
// ---------------------------------------------------------------------------

type VChunk = { anchor: string | null; eof: boolean; o: OLine[]; n: NLine[] };
type VEdit =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[] };
type RawLine = { text: string; no: number };

function parseV4AUpdate(path: string, headerLine: number, body: RawLine[]): VEdit {
  let moveTo: string | null = null;
  let idx = 0;
  if (body.length > 0 && body[0].text.startsWith('*** Move to:')) {
    moveTo = body[0].text.slice('*** Move to:'.length).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  for (; idx < body.length; idx++) {
    const text = body[idx].text;
    const no = body[idx].no;
    if (text.startsWith('@@')) {
      const anchorText = text.slice(2).trim();
      cur = { anchor: anchorText === '' ? null : anchorText, eof: false, o: [], n: [] };
      chunks.push(cur);
      continue;
    }
    if (text === '*** End of File') {
      if (!cur) {
        cur = { anchor: null, eof: false, o: [], n: [] };
        chunks.push(cur);
      }
      cur.eof = true;
      cur = null;
      continue;
    }
    const isBody = text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+';
    if (!isBody) throw new ParseFail(no);
    if (!cur) {
      if (chunks.length > 0) throw new ParseFail(no);
      cur = { anchor: null, eof: false, o: [], n: [] };
      chunks.push(cur);
    }
    if (text === '' || text[0] === ' ') {
      const t = text === '' ? '' : text.slice(1);
      const oIndex = cur.o.length;
      cur.o.push({ text: t, ctx: true });
      cur.n.push({ text: t, ctx: true, oIndex });
    } else if (text[0] === '-') {
      cur.o.push({ text: text.slice(1), ctx: false });
    } else {
      cur.n.push({ text: text.slice(1), ctx: false, oIndex: -1 });
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new ParseFail(headerLine);
  return { kind: 'update', path, moveTo, chunks };
}

function parseV4A(lines: string[]): VEdit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first < 0) throw new ParseFail(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFail(first + 1);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      last = i;
      break;
    }
  }
  if (last <= first || lines[last].trim() !== '*** End Patch') {
    throw new ParseFail(lines.length + 1);
  }

  const sectionKind = (l: string): 'add' | 'delete' | 'update' | null => {
    if (l.startsWith('*** Add File:')) return 'add';
    if (l.startsWith('*** Delete File:')) return 'delete';
    if (l.startsWith('*** Update File:')) return 'update';
    return null;
  };

  const edits: VEdit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i];
    if (l.trim() === '') {
      i++;
      continue;
    }
    const kind = sectionKind(l);
    if (!kind) throw new ParseFail(i + 1);
    const prefix =
      kind === 'add' ? '*** Add File:' : kind === 'delete' ? '*** Delete File:' : '*** Update File:';
    const path = l.slice(prefix.length).trim();
    const headerLine = i + 1;
    i++;
    const body: RawLine[] = [];
    while (i < last && !sectionKind(lines[i])) {
      body.push({ text: lines[i], no: i + 1 });
      i++;
    }
    // Blank lines at the end of a section are not part of it. A blank line
    // is an empty line or a line of only whitespace (SPEC section 4), so a
    // trailing context line holding only its leading space goes too.
    while (body.length > 0 && body[body.length - 1].text.trim() === '') body.pop();
    if (kind === 'add') {
      const flines: string[] = [];
      for (const b of body) {
        if (b.text.startsWith('+')) flines.push(b.text.slice(1));
        else if (b.text === '') flines.push('');
        else throw new ParseFail(b.no);
      }
      edits.push({ kind: 'add', path, lines: flines });
    } else if (kind === 'delete') {
      if (body.length > 0) throw new ParseFail(body[0].no);
      edits.push({ kind: 'delete', path });
    } else {
      edits.push(parseV4AUpdate(path, headerLine, body));
    }
  }
  return edits;
}

function applyV4A(
  tree: Tree,
  e: VEdit,
  strict: boolean,
  moves: { old: string; new: string }[],
): void {
  requireSafe(e.path);
  if (e.kind === 'add') {
    if (tree.get(e.path) !== null) throw new EditFail('exists', e.path);
    tree.set(e.path, renderFileText({ lines: e.lines, brk: '\n', finalBreak: true }));
    return;
  }
  if (e.kind === 'delete') {
    if (tree.get(e.path) === null) throw new EditFail('missing', e.path);
    tree.set(e.path, null);
    return;
  }
  // update
  if (e.moveTo !== null) requireSafe(e.moveTo);
  const cur = tree.get(e.path);
  if (cur === null) throw new EditFail('missing', e.path);
  if (e.moveTo !== null && tree.get(e.moveTo) !== null) throw new EditFail('exists', e.moveTo);
  const st = parseFileText(cur);
  let lines = st.lines;
  let cursor = 0;
  for (const ch of e.chunks) {
    if (ch.anchor !== null) {
      const anchorO: OLine[] = [{ text: ch.anchor, ctx: false }];
      const foundA = findTier(lines, anchorO, strict, (p) => p >= cursor);
      if (!foundA) throw new EditFail('no-match', e.path);
      cursor = foundA.positions[0] + 1;
    }
    if (ch.o.length === 0) {
      const pos = ch.eof ? lines.length : cursor;
      lines = spliceLines(lines, pos, 0, ch.n.map((x) => x.text));
      cursor = pos + ch.n.length;
    } else {
      const accept = ch.eof
        ? (p: number) => p >= cursor && p + ch.o.length === lines.length
        : (p: number) => p >= cursor;
      const found = findTier(lines, ch.o, strict, accept);
      if (!found) throw new EditFail('no-match', e.path);
      const pos = found.positions[0];
      const repl = buildReplacement(lines, pos, ch.o, ch.n, found.tier);
      lines = spliceLines(lines, pos, ch.o.length, repl);
      cursor = pos + repl.length;
    }
  }
  const out = renderFileText({ lines, brk: st.brk, finalBreak: st.finalBreak });
  if (e.moveTo !== null) {
    tree.set(e.moveTo, out);
    tree.set(e.path, null);
    moves.push({ old: e.path, new: e.moveTo });
  } else {
    tree.set(e.path, out);
  }
}

// ---------------------------------------------------------------------------
// Text-editor JSON (SPEC section 9)
// ---------------------------------------------------------------------------

type JEdit =
  | { op: 'create'; path: string; fileText: string }
  | { op: 'str_replace'; path: string; oldStr: string; newStr: string }
  | { op: 'insert'; path: string; insertLine: number; newStr: string };

function parseJSONEdit(v: unknown): JEdit | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string' || typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { op: 'create', path: o.path, fileText: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if ('new_str' in o && typeof o.new_str !== 'string') return null;
    return {
      op: 'str_replace',
      path: o.path,
      oldStr: o.old_str,
      newStr: typeof o.new_str === 'string' ? o.new_str : '',
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) return null;
    if (typeof o.new_str !== 'string') return null;
    return { op: 'insert', path: o.path, insertLine: o.insert_line, newStr: o.new_str };
  }
  return null;
}

function parseJSON(text: string, lines: string[]): JEdit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first < 0) throw new ParseFail(1);
  if (lines[first].trimStart().startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new ParseFail(first + 1);
    }
    if (!Array.isArray(arr)) throw new ParseFail(first + 1);
    const edits: JEdit[] = [];
    for (const v of arr) {
      const e = parseJSONEdit(v);
      if (!e) throw new ParseFail(first + 1);
      edits.push(e);
    }
    return edits;
  }
  const edits: JEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    let v: unknown;
    try {
      v = JSON.parse(lines[i]);
    } catch {
      throw new ParseFail(i + 1);
    }
    const e = parseJSONEdit(v);
    if (!e) throw new ParseFail(i + 1);
    edits.push(e);
  }
  return edits;
}

function applyJSON(tree: Tree, e: JEdit): void {
  requireSafe(e.path);
  const cur = tree.get(e.path);
  if (e.op === 'create') {
    if (cur !== null) throw new EditFail('exists', e.path);
    tree.set(e.path, e.fileText);
    return;
  }
  if (cur === null) throw new EditFail('missing', e.path);
  if (e.op === 'str_replace') {
    const nl = cur.indexOf('\n');
    const crlf = nl > 0 && cur[nl - 1] === '\r';
    const hay = crlf ? cur.replaceAll('\r\n', '\n') : cur;
    const needle = crlf ? e.oldStr.replaceAll('\r\n', '\n') : e.oldStr;
    const repl = crlf ? e.newStr.replaceAll('\r\n', '\n') : e.newStr;
    let count = 0;
    let idx = -1;
    let from = 0;
    for (;;) {
      const j = hay.indexOf(needle, from);
      if (j < 0) break;
      count++;
      idx = j;
      from = j + 1; // occurrences may overlap
    }
    if (count === 0) throw new EditFail('no-match', e.path);
    if (count > 1) throw new EditFail('ambiguous', e.path);
    const out = hay.slice(0, idx) + repl + hay.slice(idx + needle.length);
    tree.set(e.path, crlf ? out.replaceAll('\n', '\r\n') : out);
    return;
  }
  // insert
  const st = parseFileText(cur);
  if (e.insertLine < 0 || e.insertLine > st.lines.length) throw new EditFail('no-match', e.path);
  const insLines = e.newStr === '' ? [] : patchLinesOf(e.newStr);
  const lines = spliceLines(st.lines, e.insertLine, 0, insLines);
  tree.set(e.path, renderFileText({ lines, brk: st.brk, finalBreak: st.finalBreak }));
}

// ---------------------------------------------------------------------------
// Format detection (SPEC section 4) and the command line (sections 1, 2, 10)
// ---------------------------------------------------------------------------

type FormatName = 'unified' | 'search-replace' | 'v4a' | 'json';

function detectFormat(lines: string[]): FormatName | null {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '') {
      first = i;
      break;
    }
  }
  if (first >= 0 && lines[first].trim() === '*** Begin Patch') return 'v4a';
  if (first >= 0) {
    const c = lines[first].trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (lines[i].startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      return 'unified';
    }
  }
  return null;
}

type Edit =
  | { kind: 'unified'; sec: USection }
  | { kind: 'sr'; e: SREdit }
  | { kind: 'v4a'; e: VEdit }
  | { kind: 'json'; e: JEdit };

function applyEdit(
  tree: Tree,
  e: Edit,
  strict: boolean,
  moves: { old: string; new: string }[],
): void {
  if (e.kind === 'unified') applyUnifiedSection(tree, e.sec, strict, moves);
  else if (e.kind === 'sr') applySR(tree, e.e, strict);
  else if (e.kind === 'v4a') applyV4A(tree, e.e, strict, moves);
  else applyJSON(tree, e.e);
}

function out2(msg: string): number {
  process.stdout.write(msg + '\n');
  return 2;
}

function main(argv: string[]): number {
  let format = 'auto';
  let formatSet = false;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        const v = a.slice('--format='.length);
        if (formatSet || !['unified', 'search-replace', 'v4a', 'json', 'auto'].includes(v)) {
          return out2('error: usage');
        }
        format = v;
        formatSet = true;
      } else if (a === '--check') {
        if (check) return out2('error: usage');
        check = true;
      } else if (a === '--strict') {
        if (strict) return out2('error: usage');
        strict = true;
      } else {
        return out2('error: usage');
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return out2('error: usage');

  const file = pos.length === 1 ? pos[0] : null;
  let text: string;
  if (file === null || file === '-') {
    try {
      text = readFileSync(0, 'utf8');
    } catch {
      text = '';
    }
  } else {
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return out2('error: no-patch');
    }
  }
  const lines = patchLinesOf(text);

  let fmt: FormatName;
  if (format === 'auto') {
    const d = detectFormat(lines);
    if (!d) return out2('error: format');
    fmt = d;
  } else {
    fmt = format as FormatName;
  }

  let edits: Edit[];
  try {
    if (fmt === 'unified') {
      edits = parseUnified(lines).map((sec) => ({ kind: 'unified' as const, sec }));
    } else if (fmt === 'search-replace') {
      edits = parseSearchReplace(lines).map((e) => ({ kind: 'sr' as const, e }));
    } else if (fmt === 'v4a') {
      edits = parseV4A(lines).map((e) => ({ kind: 'v4a' as const, e }));
    } else {
      edits = parseJSON(text, lines).map((e) => ({ kind: 'json' as const, e }));
    }
  } catch (err) {
    if (err instanceof ParseFail) return out2('error: parse ' + err.line);
    throw err;
  }
  if (edits.length === 0) return out2('error: parse 1');

  const tree = new Tree();
  const moves: { old: string; new: string }[] = [];
  const failures: { code: FailCode; path: string }[] = [];
  for (const e of edits) {
    const snap = tree.snapshot();
    const movesBefore = moves.length;
    try {
      applyEdit(tree, e, strict, moves);
    } catch (err) {
      if (err instanceof EditFail) {
        tree.restore(snap);
        moves.length = movesBefore;
        failures.push({ code: err.code, path: err.path });
      } else {
        throw err;
      }
    }
  }
  if (failures.length > 0) {
    const out = failures.map((f) => 'error: ' + f.code + ' ' + f.path);
    out.push('failed: ' + failures.length + ' of ' + edits.length + ' edits');
    process.stdout.write(out.join('\n') + '\n');
    return 1;
  }

  const rows: { key: string; text: string }[] = [];
  const suppressed = new Set<string>();
  const seenPairs = new Set<string>();
  for (const mv of moves) {
    const id = mv.old + '\u0000' + mv.new;
    if (seenPairs.has(id)) continue;
    seenPairs.add(id);
    if (
      tree.original(mv.old) !== null &&
      tree.get(mv.old) === null &&
      tree.original(mv.new) === null &&
      tree.get(mv.new) !== null
    ) {
      rows.push({ key: mv.new, text: 'R ' + mv.old + ' -> ' + mv.new });
      suppressed.add(mv.old);
      suppressed.add(mv.new);
    }
  }
  for (const p of tree.touched()) {
    if (suppressed.has(p)) continue;
    const before = tree.original(p);
    const after = tree.get(p);
    if (before === after) continue;
    if (before === null) rows.push({ key: p, text: 'A ' + p });
    else if (after === null) rows.push({ key: p, text: 'D ' + p });
    else rows.push({ key: p, text: 'M ' + p });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  const outLines = rows.map((r) => r.text);
  outLines.push('ok: ' + rows.length + (rows.length === 1 ? ' file' : ' files'));
  process.stdout.write(outLines.join('\n') + '\n');

  if (!check) {
    for (const p of tree.touched()) {
      const after = tree.get(p);
      if (after === tree.original(p)) continue;
      if (after === null) {
        rmSync(p, { force: true });
      } else {
        const dir = dirname(p);
        if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
        writeFileSync(p, after);
      }
    }
  }
  return 0;
}

if (process.env.MAKEFUN_ENV_URL) {
  const { runTrial } = await import('./runner.ts');
  await runTrial();
} else {
  process.exit(main(process.argv.slice(2)));
}

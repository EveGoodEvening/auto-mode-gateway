import type { ResponseBudget, ResponseReservation } from './response-budget.js';

export type JsonRetentionProtocol = 'responses' | 'anthropic' | 'chat';
export interface JsonRetention {
  bytes: number;
  reasoningBytes: number;
  pendingBytes: number;
  complete: boolean;
  ambiguous: boolean;
  type?: string;
  itemType?: string;
  partType?: string;
  outputIndex?: number;
}

type Role = 'root' | 'response' | 'items' | 'candidate' | 'item' | 'part' | 'other';
type Frame = {
  kind: 'object' | 'array'; role: Role; start: number; state: string; key: string;
  type?: string; itemType?: string; partType?: string; outputIndex?: number;
  signature: boolean; reasoning: number; nested: Map<string, number>;
  lease?: ResponseReservation;
};
const keys: Record<string, true> = { type: true, output: true, content: true, signature: true, response: true, item: true, part: true, output_index: true, content_block: true, delta: true, index: true, reasoning_content: true, choices: true, message: true };
const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/** A bounded SAX scanner: payload strings and numeric lexemes are never retained. */
export class JsonRetentionScanner {
  private bytes = 0;
  private bad = false;
  private done = false;
  private stack: Frame[] = [];
  private root?: Frame;
  private token: 'string' | 'primitive' | undefined;
  private text = '';
  private overflow = false;
  private keyToken = false;
  private capture = false;
  private escape = false;
  private unicode = '';
  private stringStart = 0;
  private unicodeRemaining = 0;
  private utfRemaining = 0;
  private utfCode = 0;
  private utfMinimum = 0;
  private workspace?: ResponseReservation;
  private numberState = '';
  private literalRemaining = '';
  private finalStatus?: JsonRetention;

  constructor(private readonly protocol: JsonRetentionProtocol, private readonly mode: 'response' | 'event', private readonly budget?: ResponseBudget) {
    this.workspace = budget?.reserve(2048, 2048);
  }

  feed(bytes: Uint8Array): void {
    if (this.finalStatus) throw new Error('JSON scanner is complete');
    for (const byte of bytes) {
      this.bytes++;
      if (this.bad) continue;
      if (this.utfRemaining) {
        if ((byte & 0xc0) !== 0x80) { this.bad = true; continue; }
        this.utfCode = (this.utfCode << 6) | (byte & 63);
        if (--this.utfRemaining === 0) {
          if (this.utfCode < this.utfMinimum || this.utfCode > 0x10ffff || (this.utfCode >= 0xd800 && this.utfCode <= 0xdfff)) this.bad = true;
          else if (!(this.utfCode === 0xfeff && this.bytes === 3)) this.character(String.fromCodePoint(this.utfCode), this.bytes);
        }
      } else if (byte < 128) this.character(String.fromCharCode(byte), this.bytes);
      else if (byte >= 0xc2 && byte <= 0xf4) {
        this.utfRemaining = byte < 0xe0 ? 1 : byte < 0xf0 ? 2 : 3;
        this.utfCode = byte & (this.utfRemaining === 1 ? 31 : this.utfRemaining === 2 ? 15 : 7);
        this.utfMinimum = this.utfRemaining === 1 ? 128 : this.utfRemaining === 2 ? 2048 : 65536;
      } else this.bad = true;
    }
  }

  finish(): JsonRetention {
    if (this.finalStatus) return this.finalStatus;
    if (this.token === 'primitive') this.endPrimitive();
    if (this.utfRemaining || this.token || this.stack.length || !this.done) this.bad = true;
    const result = this.snapshot();
    const root = this.root;
    this.root = undefined;
    this.text = '';
    this.unicode = '';
    for (const frame of this.stack) frame.lease?.release();
    this.stack.length = 0;
    root?.lease?.release();
    this.workspace?.release();
    this.workspace = undefined;
    this.finalStatus = result;
    return result;
  }

  private append(value: string): void {
    if (!this.capture || this.overflow) return;
    const maximum = this.keyToken ? 17 : 128;
    if (this.text.length + value.length > maximum) { this.overflow = true; this.text = ''; }
    else this.text += value;
  }

  private character(char: string, position: number): void {
    if (this.token === 'string') {
      if (this.unicodeRemaining) {
        if (!/^[0-9a-fA-F]$/.test(char)) { this.bad = true; return; }
        this.unicode += char;
        if (--this.unicodeRemaining === 0) { this.append(String.fromCharCode(Number.parseInt(this.unicode, 16))); this.unicode = ''; }
      } else if (this.escape) {
        this.escape = false;
        if (char === 'u') { this.unicodeRemaining = 4; this.unicode = ''; }
        else {
          if (!Object.hasOwn(escapes, char)) this.bad = true;
          else this.append(escapes[char]!);
        }
      } else if (char === '\\') this.escape = true;
      else if (char === '"') {
        const parent = this.stack[this.stack.length - 1];
        if (this.protocol === 'chat' && !this.keyToken && parent?.key === 'reasoning_content') parent.nested.set(parent.key, position - this.stringStart);
        this.token = undefined;
        const frame = this.stack[this.stack.length - 1];
        if (this.keyToken) {
          if (!frame) { this.bad = true; return; }
          frame.key = !this.overflow && Object.hasOwn(keys, this.text) ? this.text : '';
          frame.state = 'colon';
        } else this.scalar(this.overflow ? undefined : this.text, 'string');
      } else if (char.charCodeAt(0) < 32) this.bad = true;
      else this.append(char);
      return;
    }
    if (this.token === 'primitive') {
      if (!' \n\r\t,]}'.includes(char)) { this.advancePrimitive(char); this.append(char); return; }
      this.endPrimitive();
      if (this.bad) return;
    }
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t') return;
    const frame = this.stack[this.stack.length - 1];
    if (this.done) { this.bad = true; return; }
    if (frame?.state === 'colon') {
      if (char !== ':') this.bad = true;
      else frame.state = 'value';
      return;
    }
    if (frame?.state === 'comma') {
      if (char === (frame.kind === 'object' ? '}' : ']')) this.close(position);
      else if (char === ',') frame.state = frame.kind === 'object' ? 'key' : 'value';
      else this.bad = true;
      return;
    }
    if (frame?.kind === 'object' && (frame.state === 'key' || frame.state === 'firstKey')) {
      if (char === '}' && frame.state === 'firstKey') { this.close(position); return; }
      if (char !== '"') { this.bad = true; return; }
      this.startString(true); return;
    }
    if (frame?.kind === 'array' && frame.state === 'firstValue' && char === ']') { this.close(position); return; }
    if (frame && !['value', 'firstValue'].includes(frame.state)) { this.bad = true; return; }
    if (frame?.kind === 'object') {
      // Last duplicate wins, including a replacement with a scalar or wrong container.
      frame.nested.delete(frame.key);
      if (frame.key === 'type') frame.type = undefined;
      if (frame.key === (this.protocol === 'responses' ? 'item' : 'content_block')) frame.itemType = undefined;
      if (frame.key === (this.protocol === 'responses' ? 'part' : 'delta')) frame.partType = undefined;
      if (this.indexField(frame)) frame.outputIndex = undefined;
      if (frame.key === 'signature') frame.signature = true;
    }
    if (char === '{' || char === '[') {
      if (frame && ((frame.role !== 'other' && frame.key === 'type') || this.indexField(frame))) this.bad = true;
      if (char === '[' && frame && ['item', 'part'].includes(this.role(frame, false))) this.bad = true;
      if (!this.budget && this.stack.length >= 128) { this.bad = true; return; }
      const role = this.role(frame, char === '[');
      const lease = this.budget?.reserve(1024, 1024);
      const next: Frame = { kind: char === '{' ? 'object' : 'array', role, start: position - 1, state: char === '{' ? 'firstKey' : 'firstValue', key: '', signature: false, reasoning: 0, nested: new Map(), lease };
      if (!frame) this.root = next;
      this.stack.push(next);
    } else if (char === '"') this.startString(false);
    else if (char === '-' || /[0-9tfn]/.test(char)) {
      this.token = 'primitive'; this.text = ''; this.overflow = false; this.capture = true; this.keyToken = false; this.append(char);
      this.literalRemaining = char === 't' ? 'rue' : char === 'f' ? 'alse' : char === 'n' ? 'ull' : '';
      this.numberState = this.literalRemaining ? 'literal' : char === '-' ? 'minus' : char === '0' ? 'zero' : 'integer';
    } else this.bad = true;
  }

  private startString(key: boolean): void {
    this.token = 'string'; this.text = ''; this.overflow = false; this.keyToken = key;
    this.stringStart = this.bytes - 1;
    const parent = this.stack[this.stack.length - 1];
    this.capture = key || !!parent && ((parent.role !== 'other' && parent.key === 'type') || this.indexField(parent));
  }

  private advancePrimitive(char: string): void {
    const digit = char >= '0' && char <= '9';
    const exponent = char === 'e' || char === 'E';
    switch (this.numberState) {
      case 'literal':
        if (char !== this.literalRemaining[0]) this.bad = true;
        else { this.literalRemaining = this.literalRemaining.slice(1); if (!this.literalRemaining) this.numberState = 'literalDone'; }
        break;
      case 'minus': this.numberState = char === '0' ? 'zero' : digit ? 'integer' : ''; break;
      case 'zero': this.numberState = char === '.' ? 'dot' : exponent ? 'exponent' : ''; break;
      case 'integer': if (!digit) this.numberState = char === '.' ? 'dot' : exponent ? 'exponent' : ''; break;
      case 'dot': this.numberState = digit ? 'fraction' : ''; break;
      case 'fraction': if (!digit) this.numberState = exponent ? 'exponent' : ''; break;
      case 'exponent': this.numberState = char === '+' || char === '-' ? 'exponentSign' : digit ? 'exponentDigits' : ''; break;
      case 'exponentSign': this.numberState = digit ? 'exponentDigits' : ''; break;
      case 'exponentDigits': if (!digit) this.numberState = ''; break;
      default: this.numberState = '';
    }
    if (!this.numberState) this.bad = true;
  }

  private endPrimitive(): void {
    this.token = undefined;
    if (!['zero', 'integer', 'fraction', 'exponentDigits', 'literalDone'].includes(this.numberState)) { this.bad = true; return; }
    this.scalar(this.overflow ? undefined : this.text, 'primitive');
  }

  private scalar(value: string | undefined, kind: 'string' | 'primitive'): void {
    const frame = this.stack[this.stack.length - 1];
    if (!frame) { this.bad = true; return; }
    if (['item', 'part'].includes(this.role(frame, false))) this.bad = true;
    if (frame.kind === 'object' && frame.role !== 'other' && frame.key === 'type') {
      if (kind !== 'string' || value === undefined) this.bad = true;
      else frame.type = value;
    }
    if (frame.kind === 'object' && this.indexField(frame)) {
      if (kind !== 'primitive' || value === undefined || !/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value) || !Number.isFinite(Number(value))) this.bad = true;
      else frame.outputIndex = Number(value);
    }
    frame.state = 'comma';
  }

  private indexField(frame: Frame): boolean {
    return this.mode === 'event' && frame.role === 'root' && frame.key === (this.protocol === 'responses' ? 'output_index' : 'index');
  }

  private role(parent: Frame | undefined, array: boolean): Role {
    if (!parent) return 'root';
    if (parent.role === 'items') return array ? 'other' : 'candidate';
    if ((parent.role === 'root' && this.mode === 'response') || parent.role === 'response') {
      if (array && parent.key === (this.protocol === 'responses' ? 'output' : 'content')) return 'items';
    }
    if (this.mode === 'event' && parent.role === 'root') {
      if (!array && parent.key === 'response') return 'response';
      if (!array && parent.key === (this.protocol === 'responses' ? 'item' : 'content_block')) return 'item';
      if (!array && parent.key === (this.protocol === 'responses' ? 'part' : 'delta')) return 'part';
    }
    return 'other';
  }

  private ownReasoning(frame: Frame): boolean {
    return ['candidate', 'item', 'part'].includes(frame.role) && (this.protocol === 'responses' ? frame.type === 'reasoning' : ['thinking', 'redacted_thinking', 'signature'].includes(frame.type ?? '') || frame.signature);
  }

  private total(frame: Frame): number {
    let total = frame.reasoning;
    for (const size of frame.nested.values()) total += size;
    return total;
  }

  private close(position: number): void {
    const frame = this.stack.pop();
    if (!frame) { this.bad = true; return; }
    if ((frame.role === 'item' || (frame.role === 'part' && this.protocol === 'responses')) && frame.type === undefined) this.bad = true;
    const amount = this.ownReasoning(frame) ? position - frame.start : this.total(frame);
    const chatReasoning = this.protocol === 'chat' && this.stack[this.stack.length - 1]?.key === 'reasoning_content';
    const parent = this.stack[this.stack.length - 1];
    if (!parent) { this.done = true; frame.reasoning = amount; frame.nested.clear(); return; }
    if (parent.kind === 'array') parent.reasoning += amount;
    else {
      parent.nested.set(parent.key, chatReasoning ? position - frame.start : amount);
      if (frame.role === 'item') parent.itemType = frame.type;
      if (frame.role === 'part') parent.partType = frame.type;
    }
    parent.state = 'comma';
    frame.lease?.release();
  }

  snapshot(): JsonRetention {
    if (this.finalStatus) return this.finalStatus;
    let reasoningBytes = 0;
    let pendingBytes = 0;
    if (this.done && this.root) reasoningBytes = this.total(this.root);
    else {
      if (this.protocol === 'chat' && this.token === 'string' && !this.keyToken && this.stack[this.stack.length - 1]?.key === 'reasoning_content') pendingBytes += this.bytes - this.stringStart;
      for (const frame of this.stack) {
        if (['candidate', 'item', 'part'].includes(frame.role)) { pendingBytes += this.bytes - frame.start; break; }
        reasoningBytes += this.total(frame);
      }
    }
    if (this.bad || (this.mode === 'event' && !this.done)) { reasoningBytes = 0; pendingBytes = this.bytes; }
    return { bytes: this.bytes, reasoningBytes, pendingBytes, complete: this.done && !this.bad && !this.token && !this.utfRemaining, ambiguous: this.bad, type: this.root?.type, itemType: this.root?.itemType, partType: this.root?.partType, outputIndex: this.root?.outputIndex };
  }
}

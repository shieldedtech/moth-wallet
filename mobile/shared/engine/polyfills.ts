// ES2025 built-ins the wallet SDK uses that older Android System WebViews lack: Set methods and
// iterator helpers (Chrome 122), Array.fromAsync (Chrome 121). Without them shielded sync fails
// on, for example, the WebView 113 an Android 14 emulator image ships. Each is added only when
// missing, so current WebViews and WKWebView keep their native versions.
/* eslint-disable @typescript-eslint/no-explicit-any */

function define(target: object, name: string, value: unknown): void {
  if (!(name in target)) Object.defineProperty(target, name, { value, writable: true, configurable: true });
}

// --- Set methods: the argument is any set-like object (size, has, keys) -------------------

interface SetLike<T> {
  size: number;
  has(value: T): boolean;
  keys(): Iterator<T>;
}

const setMethods: Record<string, (this: Set<any>, other: SetLike<any>) => unknown> = {
  union(other) {
    const out = new Set(this);
    for (const v of iterate(other.keys())) out.add(v);
    return out;
  },
  intersection(other) {
    const out = new Set();
    for (const v of this) if (other.has(v)) out.add(v);
    return out;
  },
  difference(other) {
    const out = new Set(this);
    for (const v of this) if (other.has(v)) out.delete(v);
    return out;
  },
  symmetricDifference(other) {
    const out = new Set(this);
    for (const v of iterate(other.keys())) if (this.has(v)) out.delete(v);
    else out.add(v);
    return out;
  },
  isSubsetOf(other) {
    for (const v of this) if (!other.has(v)) return false;
    return true;
  },
  isSupersetOf(other) {
    for (const v of iterate(other.keys())) if (!this.has(v)) return false;
    return true;
  },
  isDisjointFrom(other) {
    for (const v of this) if (other.has(v)) return false;
    return true;
  },
};
for (const [name, fn] of Object.entries(setMethods)) define(Set.prototype, name, fn);

function* iterate<T>(it: Iterator<T>): Generator<T> {
  for (let r = it.next(); !r.done; r = it.next()) yield r.value;
}

// --- Iterator helpers, on %IteratorPrototype% so array, Map, Set and generator iterators get them

const IteratorPrototype = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));

const iteratorMethods: Record<string, (this: Iterator<any>, ...args: any[]) => unknown> = {
  *map(fn: (v: any, i: number) => any) {
    let i = 0;
    for (const v of iterate(this)) yield fn(v, i++);
  },
  *filter(fn: (v: any, i: number) => boolean) {
    let i = 0;
    for (const v of iterate(this)) if (fn(v, i++)) yield v;
  },
  *flatMap(fn: (v: any, i: number) => Iterable<any>) {
    let i = 0;
    for (const v of iterate(this)) yield* fn(v, i++);
  },
  *take(limit: number) {
    if (limit <= 0) return;
    let n = 0;
    for (const v of iterate(this)) {
      yield v;
      if (++n >= limit) return;
    }
  },
  *drop(count: number) {
    let n = 0;
    for (const v of iterate(this)) if (n++ >= count) yield v;
  },
  toArray() {
    return [...iterate(this)];
  },
  forEach(fn: (v: any, i: number) => void) {
    let i = 0;
    for (const v of iterate(this)) fn(v, i++);
  },
  some(fn: (v: any, i: number) => boolean) {
    let i = 0;
    for (const v of iterate(this)) if (fn(v, i++)) return true;
    return false;
  },
  every(fn: (v: any, i: number) => boolean) {
    let i = 0;
    for (const v of iterate(this)) if (!fn(v, i++)) return false;
    return true;
  },
  find(fn: (v: any, i: number) => boolean) {
    let i = 0;
    for (const v of iterate(this)) if (fn(v, i++)) return v;
    return undefined;
  },
  reduce(fn: (acc: any, v: any, i: number) => any, ...init: any[]) {
    const it = iterate(this);
    let i = 0;
    let acc = init[0];
    if (init.length === 0) {
      const first = it.next();
      if (first.done) throw new TypeError('Reduce of empty iterator with no initial value');
      acc = first.value;
      i = 1;
    }
    for (const v of it) acc = fn(acc, v, i++);
    return acc;
  },
};
for (const [name, fn] of Object.entries(iteratorMethods)) define(IteratorPrototype, name, fn);

// --- Array.fromAsync -------------------------------------------------------------------------

define(Array, 'fromAsync', async function fromAsync(items: AsyncIterable<any> | Iterable<any>, mapFn?: (v: any, i: number) => any) {
  const out: any[] = [];
  let i = 0;
  const source: any = items;
  if (source[Symbol.asyncIterator]) for await (const v of source) out.push(mapFn ? await mapFn(v, i++) : v);
  else for (const v of source) out.push(mapFn ? await mapFn(await v, i++) : await v);
  return out;
});

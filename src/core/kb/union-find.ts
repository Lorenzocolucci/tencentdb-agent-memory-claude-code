/**
 * Union-Find (disjoint-set) with path-compression — used by bug-clusters.ts
 * to compute connected components of the similarity graph.
 *
 * Immutability note: UnionFind is intentionally stateful (it IS a mutable data
 * structure by design). The parent map is private; callers never receive a
 * reference to it. `components()` returns a new Map each time.
 */

export class UnionFind {
  private readonly parent: Map<string, string>;

  constructor(ids: readonly string[]) {
    this.parent = new Map(ids.map((id) => [id, id]));
  }

  find(id: string): string {
    let root = this.parent.get(id) ?? id;
    while (root !== (this.parent.get(root) ?? root)) {
      const grandparent = this.parent.get(this.parent.get(root)!) ?? root;
      this.parent.set(root, grandparent);
      root = grandparent;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }

  /** Group all ids by their root, returning a new Map<root, id[]> each call. */
  components(): Map<string, string[]> {
    const groups = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      const list = groups.get(root) ?? [];
      list.push(id);
      groups.set(root, list);
    }
    return groups;
  }
}

/**
 * BLOCKS
 *
 * The shape every other file in tools/audit agrees on, and the one invariant that
 * makes the whole measurement defensible: a block's children EXACTLY TILE it.
 *
 *   node --test tools/audit/test/blocks.test.mjs
 *
 * The limitation worth knowing: assertPartition checks area and overlap, which
 * catches gaps and double-counting but not a child sitting outside its parent with
 * a compensating gap elsewhere. containment is checked separately, per child.
 */

/** A rectangle's area in square pixels. */
export function area(b) {
    return b.w * b.h;
}

/** Every childless block, in tree order. A childless root is its own only leaf. */
export function leaves(root) {
    if (!root.children || root.children.length === 0) {
        return [root];
    }

    return root.children.flatMap(leaves);
}

export function totalArea(blocks) {
    return blocks.reduce((sum, b) => sum + area(b), 0);
}

/** Sharing at least one pixel. Blocks that merely touch at an edge do NOT overlap. */
export function overlaps(a, b) {
    return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Throws unless every node's children exactly tile it: inside the parent, not
 * overlapping each other, and summing to the parent's area. Recurses.
 *
 * Area equality is exact integer arithmetic — every rect is whole pixels, so there
 * is no tolerance to tune and no floating-point slack to hide a bug in. THAT PREMISE IS
 * ENFORCED IN lib/rects.mjs, which rounds every coordinate as the file is loaded; it was
 * assumed and unchecked until a rect 100.33333333333334px tall broke it.
 */
export function assertPartition(root) {
    const kids = root.children ?? [];
    if (kids.length === 0) {
        return;
    }

    for (const k of kids) {
        if (k.x < root.x || k.y < root.y || k.x + k.w > root.x + root.w || k.y + k.h > root.y + root.h) {
            throw new Error(`child ${JSON.stringify(k)} escapes parent ${JSON.stringify(root)}`);
        }
    }
    for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
            if (overlaps(kids[i], kids[j])) {
                throw new Error(`children overlap: ${JSON.stringify(kids[i])} and ${JSON.stringify(kids[j])}`);
            }
        }
    }
    const sum = totalArea(kids);
    if (sum !== area(root)) {
        throw new Error(`children area ${sum} !== parent area ${area(root)} at depth ${root.depth}`);
    }

    kids.forEach(assertPartition);
}

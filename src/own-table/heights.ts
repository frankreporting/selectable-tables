/**
 * A table's body rows' heights, estimated from their text or measured once drawn, and where each row starts below
 * the header. Where a row starts is a running sum, kept until a height changes.
 */
export class Heights {
	private values: Float64Array;
	private real: Uint8Array;
	private sums: Float64Array | null = null;

	constructor(values: ArrayLike<number> = []) {
		this.values = Float64Array.from(values);
		this.real = new Uint8Array(this.values.length);
	}

	get count(): number {
		return this.values.length;
	}

	get(row: number): number {
		return this.values[row] ?? 0;
	}

	/** Whether a row's height was measured on screen, not estimated. */
	measured(row: number): boolean {
		return this.real[row] === 1;
	}

	/** Sets a row's height, measured or estimated, and says whether the height changed. */
	set(row: number, height: number, measured: boolean): boolean {
		if (row < 0 || row >= this.values.length) return false;
		this.real[row] = measured ? 1 : 0;
		if (Math.abs((this.values[row] ?? 0) - height) < 0.01) return false;
		this.values[row] = height;
		this.sums = null;
		return true;
	}

	/** Takes out `removed` rows at `at` and puts in estimated ones. */
	splice(at: number, removed: number, added: readonly number[]): void {
		const values = new Float64Array(this.values.length - removed + added.length);
		values.set(this.values.subarray(0, at));
		values.set(added, at);
		values.set(this.values.subarray(at + removed), at + added.length);
		const real = new Uint8Array(values.length);
		real.set(this.real.subarray(0, at));
		real.set(this.real.subarray(at + removed), at + added.length);
		this.values = values;
		this.real = real;
		this.sums = null;
	}

	private prefix(): Float64Array {
		if (this.sums) return this.sums;
		const sums = new Float64Array(this.values.length + 1);
		for (let r = 0; r < this.values.length; r++) sums[r + 1] = sums[r]! + this.values[r]!;
		return (this.sums = sums);
	}

	/** Where a row starts below the header. The row after the last is the body's height. */
	top(row: number): number {
		const sums = this.prefix();
		return sums[Math.max(0, Math.min(row, this.values.length))]!;
	}

	total(): number {
		return this.top(this.values.length);
	}

	/** The row at a height below the header: the first, above the body, and the last, below it. */
	rowAt(y: number): number {
		const sums = this.prefix();
		let lo = 0;
		let hi = this.values.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (sums[mid + 1]! <= y) lo = mid + 1;
			else hi = mid;
		}
		return Math.min(lo, Math.max(0, this.values.length - 1));
	}
}

/** The part of a table's body on screen, from the pane's top to its bottom, measured down from the body's top. */
export interface Visible {
	top: number;
	bottom: number;
}

/** A run of body rows, [first, end). */
export interface RowRange {
	first: number;
	end: number;
}

/** The rows to have in the page for what's on screen: those within `over` px of it. */
export function wanted(heights: Heights, visible: Visible, over: number): RowRange {
	if (!heights.count) return { first: 0, end: 0 };
	const first = heights.rowAt(Math.max(0, visible.top - over));
	const end = Math.max(first, Math.min(heights.count, heights.rowAt(Math.max(0, visible.bottom + over)) + 1));
	return { first, end };
}

/** Whether the rows in the page still reach `margin` px past what's on screen, both ways, as far as the table goes. */
export function covers(heights: Heights, drawn: RowRange, visible: Visible, margin: number): boolean {
	if (drawn.end <= drawn.first) return !heights.count;
	return heights.top(drawn.first) <= Math.max(0, visible.top - margin) && heights.top(drawn.end) >= Math.min(heights.total(), visible.bottom + margin);
}

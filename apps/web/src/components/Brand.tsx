/**
 * 邻至's mark: the house with the walker cut out and the orange path under the step (design:
 * public/brand, cleaned and sized from the identity work). A raster, drawn at 1×, 2× and 4× so it
 * stays crisp in the bar, on the 路演 card and on paper.
 */
export function BrandMark({ size = 30, className = 'brand-logo' }: { size?: number; className?: string }) {
  return (
    <img
      className={className}
      src="/brand/linzhi-mark-64.png"
      srcSet="/brand/linzhi-mark-64.png 1x, /brand/linzhi-mark-128.png 2x, /brand/linzhi-mark-256.png 4x"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

/** The product's name, in one place. */
export const BRAND = '邻至';

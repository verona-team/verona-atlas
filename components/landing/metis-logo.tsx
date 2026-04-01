export function MetisLogo({ className = '', size = 24 }: { className?: string; size?: number }) {
  const cells = 4
  const gap = size * 0.08
  const cellSize = (size - gap * (cells - 1)) / cells

  const rects: { x: number; y: number }[] = []
  for (let row = 0; row < cells; row++) {
    for (let col = 0; col < cells; col++) {
      if ((row + col) % 2 === 0) {
        rects.push({
          x: col * (cellSize + gap),
          y: row * (cellSize + gap),
        })
      }
    }
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
      aria-hidden="true"
    >
      {rects.map((r, i) => (
        <rect
          key={i}
          x={r.x}
          y={r.y}
          width={cellSize}
          height={cellSize}
          fill="currentColor"
        />
      ))}
    </svg>
  )
}

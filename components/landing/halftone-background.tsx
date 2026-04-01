'use client'

import { useEffect, useRef } from 'react'

class SimplexNoise {
  private perm: Uint8Array
  private grad3: number[][]

  constructor(seed = 0) {
    this.grad3 = [
      [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
      [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
      [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
    ]
    const p = new Uint8Array(256)
    for (let i = 0; i < 256; i++) p[i] = i
    let s = seed
    for (let i = 255; i > 0; i--) {
      s = (s * 16807 + 0) % 2147483647
      const j = s % (i + 1)
      ;[p[i], p[j]] = [p[j], p[i]]
    }
    this.perm = new Uint8Array(512)
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255]
  }

  noise2D(x: number, y: number): number {
    const F2 = 0.5 * (Math.sqrt(3.0) - 1.0)
    const G2 = (3.0 - Math.sqrt(3.0)) / 6.0
    const s = (x + y) * F2
    const i = Math.floor(x + s)
    const j = Math.floor(y + s)
    const t = (i + j) * G2
    const X0 = i - t
    const Y0 = j - t
    const x0 = x - X0
    const y0 = y - Y0
    let i1: number, j1: number
    if (x0 > y0) { i1 = 1; j1 = 0 } else { i1 = 0; j1 = 1 }
    const x1 = x0 - i1 + G2
    const y1 = y0 - j1 + G2
    const x2 = x0 - 1.0 + 2.0 * G2
    const y2 = y0 - 1.0 + 2.0 * G2
    const ii = i & 255
    const jj = j & 255
    const gi0 = this.perm[ii + this.perm[jj]] % 12
    const gi1 = this.perm[ii + i1 + this.perm[jj + j1]] % 12
    const gi2 = this.perm[ii + 1 + this.perm[jj + 1]] % 12
    let n0 = 0, n1 = 0, n2 = 0
    let t0 = 0.5 - x0 * x0 - y0 * y0
    if (t0 >= 0) { t0 *= t0; n0 = t0 * t0 * (this.grad3[gi0][0] * x0 + this.grad3[gi0][1] * y0) }
    let t1 = 0.5 - x1 * x1 - y1 * y1
    if (t1 >= 0) { t1 *= t1; n1 = t1 * t1 * (this.grad3[gi1][0] * x1 + this.grad3[gi1][1] * y1) }
    let t2 = 0.5 - x2 * x2 - y2 * y2
    if (t2 >= 0) { t2 *= t2; n2 = t2 * t2 * (this.grad3[gi2][0] * x2 + this.grad3[gi2][1] * y2) }
    return 70.0 * (n0 + n1 + n2)
  }
}

function fbm(simplex: SimplexNoise, x: number, y: number, octaves: number): number {
  let value = 0
  let amplitude = 1
  let frequency = 1
  let maxValue = 0
  for (let i = 0; i < octaves; i++) {
    value += amplitude * simplex.noise2D(x * frequency, y * frequency)
    maxValue += amplitude
    amplitude *= 0.5
    frequency *= 2
  }
  return value / maxValue
}

function marbleNoise(simplex: SimplexNoise, x: number, y: number): number {
  const warpStrength = 1.8
  const wx = fbm(simplex, x + 0.0, y + 0.0, 4)
  const wy = fbm(simplex, x + 5.2, y + 1.3, 4)

  const wx2 = fbm(simplex, x + warpStrength * wx + 1.7, y + warpStrength * wy + 9.2, 4)
  const wy2 = fbm(simplex, x + warpStrength * wx + 8.3, y + warpStrength * wy + 2.8, 4)

  return fbm(simplex, x + warpStrength * wx2, y + warpStrength * wy2, 4)
}

export function HalftoneBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const render = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const width = window.innerWidth
      const height = window.innerHeight
      canvas.width = width * dpr
      canvas.height = height * dpr
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`

      const ctx = canvas.getContext('2d')
      if (!ctx) return

      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, width, height)

      const simplex = new SimplexNoise(42)
      const dotSpacing = 7
      const maxRadius = 3.0
      const noiseScale = 0.0025

      const r = 185, g = 180, b = 70

      const clearX = width - 160
      const clearY = 28
      const clearRadius = 120

      for (let x = 0; x < width; x += dotSpacing) {
        for (let y = 0; y < height; y += dotSpacing) {
          const nx = x * noiseScale
          const ny = y * noiseScale

          const n = marbleNoise(simplex, nx, ny)

          const normalized = (n + 1) / 2
          let intensity = Math.pow(Math.max(0, normalized - 0.3) / 0.7, 0.8)

          const dx = x - clearX
          const dy = y - clearY
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist < clearRadius) {
            const fade = Math.pow(dist / clearRadius, 3)
            intensity *= fade
          }

          if (intensity > 0.03) {
            const radius = Math.min(maxRadius, intensity * maxRadius * 1.4)
            const alpha = Math.min(0.8, intensity * 0.85)

            ctx.beginPath()
            ctx.arc(x, y, radius, 0, Math.PI * 2)
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${alpha})`
            ctx.fill()
          }
        }
      }
    }

    render()

    let resizeTimer: ReturnType<typeof setTimeout>
    const handleResize = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(render, 150)
    }

    window.addEventListener('resize', handleResize)
    return () => {
      window.removeEventListener('resize', handleResize)
      clearTimeout(resizeTimer)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none"
      style={{ zIndex: 0 }}
      aria-hidden="true"
    />
  )
}

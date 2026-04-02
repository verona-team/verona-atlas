'use client'

import { useEffect, useRef, useCallback } from 'react'

interface Point3D {
  x: number
  y: number
  z: number
}

interface ProjectedPoint {
  x: number
  y: number
  z: number
  scale: number
}

const DOT_COLORS = [
  '#E53E3E', // red
  '#3B82F6', // blue
  '#1a1a1a', // black
  '#8B5CF6', // purple
  '#10B981', // green
  '#F59E0B', // amber
  '#EC4899', // pink
  '#6366F1', // indigo
  '#14B8A6', // teal
  '#F97316', // orange
  '#64748B', // slate/gray
  '#EF4444', // red variant
  '#2563EB', // blue variant
  '#A855F7', // purple variant
  '#059669', // emerald
  '#D946EF', // fuchsia
]

function rotateX(p: Point3D, angle: number): Point3D {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return { x: p.x, y: p.y * cos - p.z * sin, z: p.y * sin + p.z * cos }
}

function rotateY(p: Point3D, angle: number): Point3D {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return { x: p.x * cos + p.z * sin, y: p.y, z: -p.x * sin + p.z * cos }
}

function project(p: Point3D, fov: number, viewDist: number): ProjectedPoint {
  const safeDenominator = Math.max(viewDist + p.z, 1.0)
  const factor = fov / safeDenominator
  return { x: p.x * factor, y: p.y * factor, z: p.z, scale: factor }
}

interface DNAData {
  dotPoints: Point3D[]
  backboneCurve1: Point3D[]
  backboneCurve2: Point3D[]
  rungPairs: [number, number][]
}

function generateDNAHelix(numDots: number, numCurveSegments: number, turns: number): DNAData {
  const dotPoints: Point3D[] = []
  const backboneCurve1: Point3D[] = []
  const backboneCurve2: Point3D[] = []
  const rungPairs: [number, number][] = []

  const radius = 0.55
  const halfHeight = 1.2

  for (let i = 0; i < numDots; i++) {
    const t = i / (numDots - 1)
    const theta = t * turns * 2 * Math.PI
    const y = (t - 0.5) * 2 * halfHeight

    const idx1 = dotPoints.length
    dotPoints.push({
      x: radius * Math.cos(theta),
      y,
      z: radius * Math.sin(theta),
    })

    const idx2 = dotPoints.length
    dotPoints.push({
      x: radius * Math.cos(theta + Math.PI),
      y,
      z: radius * Math.sin(theta + Math.PI),
    })

    if (i % 2 === 0) {
      rungPairs.push([idx1, idx2])
    }
  }

  for (let i = 0; i <= numCurveSegments; i++) {
    const t = i / numCurveSegments
    const theta = t * turns * 2 * Math.PI
    const y = (t - 0.5) * 2 * halfHeight

    backboneCurve1.push({
      x: radius * Math.cos(theta),
      y,
      z: radius * Math.sin(theta),
    })
    backboneCurve2.push({
      x: radius * Math.cos(theta + Math.PI),
      y,
      z: radius * Math.sin(theta + Math.PI),
    })
  }

  return { dotPoints, backboneCurve1, backboneCurve2, rungPairs }
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function InteractiveLogo({
  size = 120,
  className = '',
}: {
  size?: number
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stateRef = useRef({
    rotX: -0.45,
    rotY: 0.75,
    velX: 0,
    velY: 0.003,
    dragging: false,
    lastMouseX: 0,
    lastMouseY: 0,
    animId: 0,
  })

  const dna = useRef(generateDNAHelix(14, 80, 2)).current
  const colorIndices = useRef(
    dna.dotPoints.map((_, i) => i % DOT_COLORS.length)
  ).current

  const PAD = 2.2
  const canvasSize = Math.ceil(size * PAD)

  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = canvasSize
    const h = canvasSize

    canvas.width = w * dpr
    canvas.height = h * dpr

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)

    const s = stateRef.current
    const fov = 250
    const viewDist = 4.5

    const transformAndProject = (p: Point3D) => {
      let rotated = rotateX(p, s.rotX)
      rotated = rotateY(rotated, s.rotY)
      return project(rotated, fov, viewDist)
    }

    const projDots = dna.dotPoints.map((p, i) => ({
      ...transformAndProject(p),
      origIdx: i,
    }))

    const projCurve1 = dna.backboneCurve1.map(transformAndProject)
    const projCurve2 = dna.backboneCurve2.map(transformAndProject)

    const sizeScale = size / 120

    const drawCurve = (curve: ProjectedPoint[]) => {
      if (curve.length < 2) return

      for (let i = 0; i < curve.length - 1; i++) {
        const p1 = curve[i]
        const p2 = curve[i + 1]
        const avgZ = (p1.z + p2.z) / 2
        const depthNorm = (avgZ + 1.8) / 3.6
        const alpha = Math.max(0.25, 0.4 + 0.6 * depthNorm)

        ctx.beginPath()
        ctx.moveTo(w / 2 + p1.x, h / 2 + p1.y)
        ctx.lineTo(w / 2 + p2.x, h / 2 + p2.y)
        ctx.strokeStyle = hexToRgba('#1e293b', alpha)
        ctx.lineWidth = Math.max(1.2, 2.5 * (0.5 + 0.5 * depthNorm) * sizeScale)
        ctx.lineCap = 'round'
        ctx.stroke()
      }
    }

    const sortedDots = [...projDots].sort((a, b) => b.z - a.z)

    for (const p of sortedDots) {
      const sx = w / 2 + p.x
      const sy = h / 2 + p.y

      const depthNorm = (p.z + 1.8) / 3.6
      const baseRadius = 7
      const radius = baseRadius * (0.55 + 0.5 * depthNorm) * sizeScale
      const alpha = 0.6 + 0.4 * depthNorm

      const dotColor = DOT_COLORS[colorIndices[p.origIdx]]

      ctx.beginPath()
      ctx.arc(sx, sy, radius, 0, Math.PI * 2)
      ctx.fillStyle = hexToRgba(dotColor, alpha)
      ctx.fill()
    }

    for (const [a, b] of dna.rungPairs) {
      const pa = projDots[a]
      const pb = projDots[b]
      const avgZ = (pa.z + pb.z) / 2
      const depthNorm = (avgZ + 1.8) / 3.6
      const alpha = Math.max(0.15, 0.25 + 0.45 * depthNorm)

      ctx.beginPath()
      ctx.moveTo(w / 2 + pa.x, h / 2 + pa.y)
      ctx.lineTo(w / 2 + pb.x, h / 2 + pb.y)
      ctx.strokeStyle = hexToRgba('#64748b', alpha)
      ctx.lineWidth = Math.max(0.8, 1.5 * (0.4 + 0.6 * depthNorm) * sizeScale)
      ctx.lineCap = 'round'
      ctx.stroke()
    }

    drawCurve(projCurve1)
    drawCurve(projCurve2)
  }, [size, canvasSize, dna, colorIndices])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const s = stateRef.current

    const animate = () => {
      if (!s.dragging) {
        s.rotY += s.velY
        s.rotX += s.velX
        s.velX *= 0.995
        s.velY *= 0.995
        if (Math.abs(s.velY) < 0.001) s.velY = 0.003
      }
      render()
      s.animId = requestAnimationFrame(animate)
    }

    s.animId = requestAnimationFrame(animate)

    const onPointerDown = (e: PointerEvent) => {
      s.dragging = true
      s.lastMouseX = e.clientX
      s.lastMouseY = e.clientY
      canvas.setPointerCapture(e.pointerId)
    }

    const onPointerMove = (e: PointerEvent) => {
      if (!s.dragging) return
      const dx = e.clientX - s.lastMouseX
      const dy = e.clientY - s.lastMouseY
      s.rotY += dx * 0.008
      s.rotX += dy * 0.008
      s.velY = dx * 0.004
      s.velX = dy * 0.004
      s.lastMouseX = e.clientX
      s.lastMouseY = e.clientY
    }

    const onPointerUp = () => {
      s.dragging = false
    }

    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointerleave', onPointerUp)

    return () => {
      cancelAnimationFrame(s.animId)
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointerleave', onPointerUp)
    }
  }, [render])

  const offset = (canvasSize - size) / 2

  return (
    <div
      className={className}
      style={{ width: size, height: size, position: 'relative', overflow: 'visible' }}
    >
      <canvas
        ref={canvasRef}
        className="cursor-grab active:cursor-grabbing"
        style={{
          position: 'absolute',
          top: -offset,
          left: -offset,
          width: canvasSize,
          height: canvasSize,
          touchAction: 'none',
        }}
        aria-label="Interactive 3D DNA helix"
      />
    </div>
  )
}

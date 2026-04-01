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
  const factor = fov / (viewDist + p.z)
  return { x: p.x * factor, y: p.y * factor, z: p.z, scale: factor }
}

function generateCubePoints(gridSize: number): Point3D[] {
  const points: Point3D[] = []
  const half = (gridSize - 1) / 2

  for (let x = 0; x < gridSize; x++) {
    for (let y = 0; y < gridSize; y++) {
      for (let z = 0; z < gridSize; z++) {
        if ((x + y + z) % 2 === 0) {
          points.push({
            x: (x - half) / half,
            y: (y - half) / half,
            z: (z - half) / half,
          })
        }
      }
    }
  }
  return points
}

export function InteractiveLogo({
  size = 120,
  className = '',
  color = '#1a1a1a',
}: {
  size?: number
  className?: string
  color?: string
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

  const points = useRef(generateCubePoints(4)).current

  const render = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = size
    const h = size

    canvas.width = w * dpr
    canvas.height = h * dpr
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, h)

    const s = stateRef.current
    const fov = 250
    const viewDist = 3.5
    const cubeScale = w * 0.3

    const projected: (ProjectedPoint & { origIdx: number })[] = points.map((p, i) => {
      let rotated = rotateX(p, s.rotX)
      rotated = rotateY(rotated, s.rotY)
      const proj = project(rotated, fov, viewDist)
      return { ...proj, origIdx: i }
    })

    projected.sort((a, b) => b.z - a.z)

    for (const p of projected) {
      const sx = w / 2 + p.x * cubeScale
      const sy = h / 2 + p.y * cubeScale

      const depthNorm = (p.z + 1.8) / 3.6
      const baseRadius = 3.2
      const radius = baseRadius * (0.6 + 0.5 * depthNorm) * (size / 120)
      const alpha = 0.3 + 0.7 * depthNorm

      ctx.beginPath()
      ctx.arc(sx, sy, radius, 0, Math.PI * 2)
      ctx.fillStyle = color.startsWith('#')
        ? hexToRgba(color, alpha)
        : color
      ctx.fill()
    }
  }, [size, color, points])

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

  return (
    <canvas
      ref={canvasRef}
      className={`cursor-grab active:cursor-grabbing ${className}`}
      style={{ width: size, height: size, touchAction: 'none' }}
      aria-label="Interactive 3D logo"
    />
  )
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

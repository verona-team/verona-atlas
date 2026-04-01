'use client'

import { useRef, useState } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import { RoundedBox, Environment } from '@react-three/drei'
import type { Mesh } from 'three'

function Cube() {
  const meshRef = useRef<Mesh>(null)
  const [hovered, setHovered] = useState(false)
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef({ x: 0, y: 0 })
  const rotationStart = useRef({ x: 0, y: 0 })

  useFrame((_state, delta) => {
    if (!meshRef.current || dragging) return
    meshRef.current.rotation.y += delta * 0.3
    meshRef.current.rotation.x += delta * 0.15
  })

  const handlePointerDown = (e: { stopPropagation: () => void; clientX: number; clientY: number }) => {
    e.stopPropagation()
    setDragging(true)
    dragStart.current = { x: e.clientX, y: e.clientY }
    if (meshRef.current) {
      rotationStart.current = {
        x: meshRef.current.rotation.x,
        y: meshRef.current.rotation.y,
      }
    }

    const handlePointerMove = (ev: PointerEvent) => {
      if (!meshRef.current) return
      const dx = ev.clientX - dragStart.current.x
      const dy = ev.clientY - dragStart.current.y
      meshRef.current.rotation.y = rotationStart.current.y + dx * 0.01
      meshRef.current.rotation.x = rotationStart.current.x + dy * 0.01
    }

    const handlePointerUp = () => {
      setDragging(false)
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
  }

  return (
    <RoundedBox
      ref={meshRef}
      args={[2, 2, 2]}
      radius={0.15}
      smoothness={4}
      onPointerOver={() => setHovered(true)}
      onPointerOut={() => setHovered(false)}
      onPointerDown={handlePointerDown}
    >
      <meshStandardMaterial
        color={hovered ? '#2a2a2a' : '#1a1a1a'}
        roughness={0.25}
        metalness={0.6}
        envMapIntensity={0.8}
      />
    </RoundedBox>
  )
}

export function InteractiveCube({ size = 200 }: { size?: number }) {
  return (
    <div
      style={{ width: size, height: size, cursor: 'grab' }}
      onMouseDown={(e) => {
        (e.currentTarget as HTMLDivElement).style.cursor = 'grabbing'
      }}
      onMouseUp={(e) => {
        (e.currentTarget as HTMLDivElement).style.cursor = 'grab'
      }}
    >
      <Canvas
        camera={{ position: [3, 2.5, 3], fov: 35 }}
        gl={{ antialias: true, alpha: true }}
        style={{ background: 'transparent' }}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[5, 5, 5]} intensity={1} />
        <directionalLight position={[-3, -1, -3]} intensity={0.3} />
        <Cube />
        <Environment preset="city" />
      </Canvas>
    </div>
  )
}

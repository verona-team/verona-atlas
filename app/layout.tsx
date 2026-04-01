import type { Metadata } from 'next'
import { VT323, IBM_Plex_Mono } from 'next/font/google'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

const vt323 = VT323({
  weight: '400',
  variable: '--font-mono-system',
  subsets: ['latin'],
})

const ibmPlexMono = IBM_Plex_Mono({
  weight: ['400', '500', '700'],
  variable: '--font-ibm-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: 'Verona — Autonomous QA that works',
  description: 'Autonomous QA that works.',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      className={`${vt323.variable} ${ibmPlexMono.variable} h-full`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground crt-glow">
        <div className="crt-overlay" />
        {children}
        <Toaster />
      </body>
    </html>
  )
}

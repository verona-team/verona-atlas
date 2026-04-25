'use client'

import { useMemo, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { normalizeProjectUrl } from '@/lib/project-url'
import { savePendingProjectUrl } from '@/lib/pending-project'

export function UrlTestInput() {
  const router = useRouter()
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const normalized = useMemo(() => normalizeProjectUrl(value), [value])
  const isValid = normalized !== null

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!isValid || submitting) return
    setSubmitting(true)
    savePendingProjectUrl(normalized!)
    router.push('/signup')
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full items-center gap-2">
      <Input
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="vercel.com"
        aria-label="Enter the URL of the web app you want to test"
        className="h-11 flex-1 px-3.5 text-[15px]"
      />
      <Button
        type="submit"
        disabled={!isValid || submitting}
        size="lg"
        className="h-11 px-5"
      >
        Test
      </Button>
    </form>
  )
}

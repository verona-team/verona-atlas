'use client'

import { useMemo, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { normalizeProjectUrl } from '@/lib/project-url'
import { savePendingProjectUrl } from '@/lib/pending-project'
import { cn } from '@/lib/utils'

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
    <form
      onSubmit={handleSubmit}
      className={cn(
        'group/input relative flex w-full items-center rounded-full border bg-white shadow-sm transition-all',
        'border-[#1a1a1a]/15 hover:border-[#1a1a1a]/30 focus-within:border-[#1a1a1a]/40 focus-within:shadow-md',
      )}
    >
      <input
        type="text"
        inputMode="url"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Paste your app URL (e.g. veronaresearch.com)"
        aria-label="Enter the URL of the web app you want to test"
        className={cn(
          'flex-1 bg-transparent py-3.5 pl-6 pr-2 text-[15px] text-[#1a1a1a] placeholder:text-[#1a1a1a]/40',
          'focus:outline-none',
        )}
      />
      <button
        type="submit"
        disabled={!isValid || submitting}
        className={cn(
          'mr-1.5 inline-flex h-10 items-center gap-1.5 rounded-full px-5 text-[14px] font-medium transition-all',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#1a1a1a]/30',
          isValid
            ? 'bg-[#1a1a1a] text-white hover:bg-[#1a1a1a]/90 active:translate-y-px'
            : 'cursor-not-allowed bg-[#1a1a1a]/10 text-[#1a1a1a]/40',
        )}
        aria-label="Test this URL"
      >
        Test
        <ArrowRight className="h-4 w-4" />
      </button>
    </form>
  )
}

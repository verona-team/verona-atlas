'use client'

import * as React from 'react'
import { Select } from '@base-ui/react/select'
import { Check, ChevronDown } from 'lucide-react'

import { cn } from '@/lib/utils'

type PickerItem = {
  value: string
  label: string
  sublabel?: string
  group?: string
}

type SearchablePickerProps = {
  id?: string
  value: string
  onChange: (value: string) => void
  items: PickerItem[]
  placeholder?: string
  disabled?: boolean
  renderValue?: (item: PickerItem | undefined) => React.ReactNode
  className?: string
}

export function SearchablePicker({
  id,
  value,
  onChange,
  items,
  placeholder = 'Select…',
  disabled,
  renderValue,
  className,
}: SearchablePickerProps) {
  // Group items by `group`. If any item has a group, show group headings.
  const hasGroups = items.some((i) => i.group)
  const grouped = React.useMemo(() => {
    if (!hasGroups) return null
    const map = new Map<string, PickerItem[]>()
    for (const it of items) {
      const key = it.group ?? ''
      const arr = map.get(key) ?? []
      arr.push(it)
      map.set(key, arr)
    }
    return Array.from(map.entries()).map(([group, groupItems]) => ({
      group,
      items: groupItems,
    }))
  }, [items, hasGroups])

  const selected = items.find((i) => i.value === value)

  return (
    <Select.Root
      value={value || null}
      onValueChange={(next) => {
        if (typeof next === 'string' && next !== value) onChange(next)
      }}
      disabled={disabled}
    >
      <Select.Trigger
        id={id}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-3 py-1.5 text-sm outline-none transition-colors focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 data-[popup-open]:border-ring data-[popup-open]:ring-3 data-[popup-open]:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 dark:hover:bg-input/50',
          className,
        )}
      >
        <span
          className={cn(
            'flex min-w-0 flex-1 items-center gap-2 truncate text-left',
            !selected && 'text-muted-foreground',
          )}
        >
          {renderValue ? renderValue(selected) : selected?.label || placeholder}
        </span>
        <Select.Icon
          render={
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
          }
        />
      </Select.Trigger>

      <Select.Portal>
        <Select.Positioner
          className="isolate z-50 outline-none"
          sideOffset={6}
          alignItemWithTrigger={false}
        >
          <Select.Popup className="max-h-(--available-height) min-w-(--anchor-width) origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95">
            <Select.List className="max-h-[min(280px,var(--available-height))] overflow-y-auto p-1">
              {hasGroups && grouped
                ? grouped.map((g) => (
                    <Select.Group
                      key={g.group || '_default'}
                      className="mb-1 last:mb-0"
                    >
                      {g.group && (
                        <Select.GroupLabel className="px-2 pt-2 pb-1 text-xs uppercase tracking-wider text-muted-foreground">
                          {g.group}
                        </Select.GroupLabel>
                      )}
                      {g.items.map((item) => (
                        <PickerOption key={item.value} item={item} />
                      ))}
                    </Select.Group>
                  ))
                : items.map((item) => (
                    <PickerOption key={item.value} item={item} />
                  ))}
            </Select.List>
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  )
}

function PickerOption({ item }: { item: PickerItem }) {
  return (
    <Select.Item
      value={item.value}
      className="relative flex w-full cursor-default select-none items-center gap-2 rounded-md px-2 py-1.5 pr-7 text-sm outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground"
    >
      <div className="flex min-w-0 flex-1 flex-col">
        <Select.ItemText className="truncate">{item.label}</Select.ItemText>
        {item.sublabel && (
          <span className="truncate text-xs text-muted-foreground">
            {item.sublabel}
          </span>
        )}
      </div>
      <Select.ItemIndicator
        render={
          <span className="pointer-events-none absolute right-2 flex size-4 items-center justify-center text-muted-foreground" />
        }
      >
        <Check className="size-3.5" />
      </Select.ItemIndicator>
    </Select.Item>
  )
}

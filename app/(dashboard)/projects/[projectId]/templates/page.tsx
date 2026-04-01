'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Loader2 } from 'lucide-react'

type StepType = 'navigate' | 'action' | 'assertion' | 'extract' | 'wait'

interface TemplateStep {
  order: number
  instruction: string
  type: StepType
  url?: string
  expected?: string
  timeout?: number
}

interface Template {
  id: string
  project_id: string
  name: string
  description: string | null
  steps: TemplateStep[]
  source: 'manual' | 'ai_generated'
  is_active: boolean
  created_at: string
  updated_at: string
}

interface GeneratedTemplate {
  name: string
  description: string
  steps: TemplateStep[]
}

const STEP_TYPES: StepType[] = ['navigate', 'action', 'assertion', 'extract', 'wait']

function emptyStep(order: number): TemplateStep {
  return { order, instruction: '', type: 'action' }
}

export default function TemplatesPage() {
  const params = useParams<{ projectId: string }>()
  const projectId = params.projectId

  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)

  const [editDialogOpen, setEditDialogOpen] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null)
  const [formName, setFormName] = useState('')
  const [formDescription, setFormDescription] = useState('')
  const [formSteps, setFormSteps] = useState<TemplateStep[]>([emptyStep(1)])
  const [saving, setSaving] = useState(false)

  const [generating, setGenerating] = useState(false)
  const [reviewDialogOpen, setReviewDialogOpen] = useState(false)
  const [generatedTemplates, setGeneratedTemplates] = useState<GeneratedTemplate[]>([])
  const [acceptedIndices, setAcceptedIndices] = useState<Set<number>>(new Set())
  const [savingGenerated, setSavingGenerated] = useState(false)

  const fetchTemplates = useCallback(async () => {
    try {
      const res = await fetch(`/api/templates?projectId=${projectId}`)
      if (res.ok) {
        const data = await res.json()
        setTemplates(data)
      }
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => {
    fetchTemplates()
  }, [fetchTemplates])

  function openCreateDialog() {
    setEditingTemplate(null)
    setFormName('')
    setFormDescription('')
    setFormSteps([emptyStep(1)])
    setEditDialogOpen(true)
  }

  function openEditDialog(template: Template) {
    setEditingTemplate(template)
    setFormName(template.name)
    setFormDescription(template.description ?? '')
    const steps = Array.isArray(template.steps) ? (template.steps as TemplateStep[]) : []
    setFormSteps(steps.length > 0 ? steps : [emptyStep(1)])
    setEditDialogOpen(true)
  }

  async function handleSave() {
    setSaving(true)
    try {
      const stepsWithOrder = formSteps.map((s, i) => ({ ...s, order: i + 1 }))
      if (editingTemplate) {
        const res = await fetch(`/api/templates/${editingTemplate.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: formName,
            description: formDescription || null,
            steps: stepsWithOrder,
          }),
        })
        if (res.ok) {
          setEditDialogOpen(false)
          fetchTemplates()
        }
      } else {
        const res = await fetch('/api/templates', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project_id: projectId,
            name: formName,
            description: formDescription || undefined,
            steps: stepsWithOrder,
            source: 'manual',
          }),
        })
        if (res.ok) {
          setEditDialogOpen(false)
          fetchTemplates()
        }
      }
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(templateId: string) {
    const res = await fetch(`/api/templates/${templateId}`, { method: 'DELETE' })
    if (res.ok || res.status === 204) {
      fetchTemplates()
    }
  }

  async function handleToggleActive(template: Template) {
    const res = await fetch(`/api/templates/${template.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !template.is_active }),
    })
    if (res.ok) {
      fetchTemplates()
    }
  }

  function updateStep(index: number, updates: Partial<TemplateStep>) {
    setFormSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, ...updates } : s)),
    )
  }

  function addStep() {
    setFormSteps((prev) => [...prev, emptyStep(prev.length + 1)])
  }

  function removeStep(index: number) {
    setFormSteps((prev) => prev.filter((_, i) => i !== index))
  }

  function moveStep(index: number, direction: 'up' | 'down') {
    setFormSteps((prev) => {
      const next = [...prev]
      const swapIdx = direction === 'up' ? index - 1 : index + 1
      if (swapIdx < 0 || swapIdx >= next.length) return prev
      ;[next[index], next[swapIdx]] = [next[swapIdx], next[index]]
      return next
    })
  }

  async function handleGenerate() {
    setGenerating(true)
    try {
      const res = await fetch('/api/templates/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId }),
      })
      if (res.ok) {
        const data = await res.json()
        setGeneratedTemplates(data)
        setAcceptedIndices(new Set())
        setReviewDialogOpen(true)
      }
    } finally {
      setGenerating(false)
    }
  }

  function toggleAccepted(index: number) {
    setAcceptedIndices((prev) => {
      const next = new Set(prev)
      if (next.has(index)) {
        next.delete(index)
      } else {
        next.add(index)
      }
      return next
    })
  }

  async function handleSaveGenerated() {
    setSavingGenerated(true)
    try {
      const toSave = generatedTemplates.filter((_, i) => acceptedIndices.has(i))
      await Promise.all(
        toSave.map((t) =>
          fetch('/api/templates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              project_id: projectId,
              name: t.name,
              description: t.description,
              steps: t.steps,
              source: 'ai_generated',
            }),
          }),
        ),
      )
      setReviewDialogOpen(false)
      fetchTemplates()
    } finally {
      setSavingGenerated(false)
    }
  }

  if (loading) {
    return (
      <div className="max-w-3xl mx-auto text-center py-12">
        <p className="text-xs text-phosphor-dim uppercase tracking-wider animate-pulse">
          Loading templates...
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="window-chrome">
        <div className="window-title-bar">
          <span className="close-box" />
          Test Templates
        </div>
        <div className="window-body space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xs text-phosphor-dim uppercase tracking-wider">
              {templates.length} template{templates.length !== 1 ? 's' : ''}
            </span>
            <div className="flex gap-2">
              <button
                onClick={handleGenerate}
                disabled={generating}
                className="text-xs uppercase tracking-wider border border-border px-3 py-1 hover:bg-accent transition-colors disabled:opacity-50"
              >
                {generating ? '...' : '✦ AI Generate'}
              </button>
              <button
                onClick={openCreateDialog}
                className="text-xs uppercase tracking-wider border border-border px-3 py-1 hover:bg-primary hover:text-primary-foreground transition-colors"
              >
                + Create
              </button>
            </div>
          </div>

          {templates.length === 0 ? (
            <div className="border border-dashed border-border py-8 text-center">
              <p className="text-xs text-phosphor-dim uppercase mb-3">
                No templates. Create one or generate with AI.
              </p>
              <div className="flex justify-center gap-2">
                <button
                  onClick={handleGenerate}
                  disabled={generating}
                  className="text-xs uppercase tracking-wider border border-border px-3 py-1 hover:bg-accent transition-colors disabled:opacity-50"
                >
                  ✦ AI Generate
                </button>
                <button
                  onClick={openCreateDialog}
                  className="text-xs uppercase tracking-wider border border-border px-3 py-1 hover:bg-primary hover:text-primary-foreground transition-colors"
                >
                  + Create
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              {templates.map((template) => (
                <div key={template.id} className="border border-border">
                  <div className="flex items-start justify-between px-3 py-2 border-b border-border">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold uppercase tracking-wider">
                          {template.name}
                        </span>
                        <span className="text-[10px] uppercase tracking-wider border border-border px-1.5 py-0">
                          {template.source === 'ai_generated' ? 'AI' : 'Manual'}
                        </span>
                      </div>
                      {template.description && (
                        <p className="text-xs text-phosphor-dim mt-0.5">{template.description}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1">
                        <span className="text-[10px] text-phosphor-dim uppercase">Active</span>
                        <Switch
                          checked={template.is_active}
                          onCheckedChange={() => handleToggleActive(template)}
                        />
                      </div>
                      <button
                        onClick={() => openEditDialog(template)}
                        className="text-[10px] uppercase tracking-wider text-phosphor-dim hover:text-foreground transition-colors"
                      >
                        [edit]
                      </button>
                      <button
                        onClick={() => handleDelete(template.id)}
                        className="text-[10px] uppercase tracking-wider text-phosphor-dim hover:text-destructive transition-colors"
                      >
                        [del]
                      </button>
                    </div>
                  </div>
                  <div className="px-3 py-2 space-y-1">
                    {(Array.isArray(template.steps) ? (template.steps as TemplateStep[]) : []).map(
                      (step, idx) => (
                        <div key={idx} className="flex items-start gap-2 text-xs">
                          <span className="text-[10px] uppercase tracking-wider border border-border px-1.5 py-0 text-phosphor-dim shrink-0">
                            {step.type}
                          </span>
                          <span className="text-phosphor-dim">{step.instruction}</span>
                        </div>
                      ),
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Create / Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto bg-card border-border">
          <DialogHeader>
            <DialogTitle className="uppercase tracking-wider text-sm">
              {editingTemplate ? 'Edit Template' : 'Create Template'}
            </DialogTitle>
            <DialogDescription className="text-xs text-phosphor-dim">
              {editingTemplate
                ? 'Update the template details and steps.'
                : 'Define a test template with ordered steps.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label className="block text-xs text-phosphor-dim uppercase tracking-wider mb-1">Name</label>
              <input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Login Flow Smoke Test"
                className="w-full bg-background border border-border px-3 py-1.5 text-sm text-foreground placeholder:text-phosphor-dim/50 focus:outline-none focus:border-foreground"
              />
            </div>

            <div>
              <label className="block text-xs text-phosphor-dim uppercase tracking-wider mb-1">Description</label>
              <textarea
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="What does this test verify?"
                rows={2}
                className="w-full bg-background border border-border px-3 py-1.5 text-sm text-foreground placeholder:text-phosphor-dim/50 focus:outline-none focus:border-foreground resize-none"
              />
            </div>

            <div className="border-t border-border pt-3 space-y-3">
              <span className="text-xs text-phosphor-dim uppercase tracking-wider">Steps</span>
              {formSteps.map((step, index) => (
                <div key={index} className="border border-border p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-phosphor-dim uppercase tracking-wider">
                      Step {index + 1}
                    </span>
                    <div className="flex gap-1">
                      <button
                        disabled={index === 0}
                        onClick={() => moveStep(index, 'up')}
                        className="text-[10px] text-phosphor-dim hover:text-foreground disabled:opacity-30 px-1"
                      >
                        ↑
                      </button>
                      <button
                        disabled={index === formSteps.length - 1}
                        onClick={() => moveStep(index, 'down')}
                        className="text-[10px] text-phosphor-dim hover:text-foreground disabled:opacity-30 px-1"
                      >
                        ↓
                      </button>
                      <button
                        disabled={formSteps.length <= 1}
                        onClick={() => removeStep(index)}
                        className="text-[10px] text-phosphor-dim hover:text-destructive disabled:opacity-30 px-1"
                      >
                        ✗
                      </button>
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[140px_1fr]">
                    <Select
                      value={step.type}
                      onValueChange={(val) => updateStep(index, { type: val as StepType })}
                    >
                      <SelectTrigger className="w-full text-xs">
                        <SelectValue placeholder="Type" />
                      </SelectTrigger>
                      <SelectContent>
                        {STEP_TYPES.map((t) => (
                          <SelectItem key={t} value={t} className="text-xs uppercase">
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <input
                      value={step.instruction}
                      onChange={(e) => updateStep(index, { instruction: e.target.value })}
                      placeholder="Instruction for the AI agent"
                      className="w-full bg-background border border-border px-3 py-1.5 text-xs text-foreground placeholder:text-phosphor-dim/50 focus:outline-none focus:border-foreground"
                    />
                  </div>
                  {step.type === 'navigate' && (
                    <input
                      value={step.url ?? ''}
                      onChange={(e) => updateStep(index, { url: e.target.value })}
                      placeholder="URL to navigate to"
                      className="w-full bg-background border border-border px-3 py-1.5 text-xs text-foreground placeholder:text-phosphor-dim/50 focus:outline-none focus:border-foreground"
                    />
                  )}
                  {step.type === 'assertion' && (
                    <input
                      value={step.expected ?? ''}
                      onChange={(e) => updateStep(index, { expected: e.target.value })}
                      placeholder="Expected result"
                      className="w-full bg-background border border-border px-3 py-1.5 text-xs text-foreground placeholder:text-phosphor-dim/50 focus:outline-none focus:border-foreground"
                    />
                  )}
                </div>
              ))}
              <button
                onClick={addStep}
                className="w-full text-xs uppercase tracking-wider border border-dashed border-border py-1.5 hover:bg-accent transition-colors"
              >
                + Add Step
              </button>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditDialogOpen(false)}
              className="text-xs uppercase tracking-wider"
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !formName.trim() || formSteps.length === 0}
              className="text-xs uppercase tracking-wider"
            >
              {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
              {editingTemplate ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AI Review Dialog */}
      <Dialog open={reviewDialogOpen} onOpenChange={setReviewDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto bg-card border-border">
          <DialogHeader>
            <DialogTitle className="uppercase tracking-wider text-sm">Review AI Templates</DialogTitle>
            <DialogDescription className="text-xs text-phosphor-dim">
              Select templates to save. Click to toggle.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            {generatedTemplates.map((gt, idx) => (
              <div
                key={idx}
                className={`cursor-pointer border p-3 transition-colors ${
                  acceptedIndices.has(idx)
                    ? 'border-foreground bg-foreground/5'
                    : 'border-border hover:border-phosphor-dim'
                }`}
                onClick={() => toggleAccepted(idx)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-bold uppercase tracking-wider">{gt.name}</span>
                      <span className="text-[10px] uppercase tracking-wider border border-border px-1.5 py-0">AI</span>
                    </div>
                    <p className="text-xs text-phosphor-dim mt-0.5">{gt.description}</p>
                  </div>
                  <span className={`text-sm ${acceptedIndices.has(idx) ? 'text-foreground' : 'text-phosphor-dim'}`}>
                    {acceptedIndices.has(idx) ? '■' : '□'}
                  </span>
                </div>
                <div className="mt-2 space-y-1">
                  {gt.steps.map((step, sIdx) => (
                    <div key={sIdx} className="flex items-start gap-2 text-xs">
                      <span className="text-[10px] uppercase tracking-wider border border-border px-1.5 py-0 text-phosphor-dim shrink-0">
                        {step.type}
                      </span>
                      <span className="text-phosphor-dim">{step.instruction}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setReviewDialogOpen(false)}
              className="text-xs uppercase tracking-wider"
            >
              Dismiss
            </Button>
            <Button
              onClick={handleSaveGenerated}
              disabled={savingGenerated || acceptedIndices.size === 0}
              className="text-xs uppercase tracking-wider"
            >
              {savingGenerated && <Loader2 className="mr-2 size-4 animate-spin" />}
              Save {acceptedIndices.size} Template{acceptedIndices.size !== 1 ? 's' : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

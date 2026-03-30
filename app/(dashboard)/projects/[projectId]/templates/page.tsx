'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
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
import {
  Plus,
  Sparkles,
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
  X,
  Loader2,
  Check,
} from 'lucide-react'

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
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Test Templates</h1>
          <p className="text-muted-foreground">
            Define test flows to run against your application.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleGenerate} disabled={generating}>
            {generating ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 size-4" />
            )}
            Generate with AI
          </Button>
          <Button onClick={openCreateDialog}>
            <Plus className="mr-2 size-4" />
            Create Template
          </Button>
        </div>
      </div>

      {templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <p className="text-muted-foreground mb-4">
              No templates yet. Create one manually or generate with AI.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={handleGenerate} disabled={generating}>
                <Sparkles className="mr-2 size-4" />
                Generate with AI
              </Button>
              <Button onClick={openCreateDialog}>
                <Plus className="mr-2 size-4" />
                Create Template
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {templates.map((template) => (
            <Card key={template.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <CardTitle>{template.name}</CardTitle>
                      <Badge
                        variant={template.source === 'ai_generated' ? 'secondary' : 'outline'}
                      >
                        {template.source === 'ai_generated' ? 'AI Generated' : 'Manual'}
                      </Badge>
                    </div>
                    {template.description && (
                      <CardDescription>{template.description}</CardDescription>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`active-${template.id}`} className="text-xs text-muted-foreground">
                        Active
                      </Label>
                      <Switch
                        id={`active-${template.id}`}
                        checked={template.is_active}
                        onCheckedChange={() => handleToggleActive(template)}
                      />
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => openEditDialog(template)}
                    >
                      <Pencil className="size-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => handleDelete(template.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-1">
                  {(Array.isArray(template.steps) ? (template.steps as TemplateStep[]) : []).map(
                    (step, idx) => (
                      <div key={idx} className="flex items-start gap-2 text-sm">
                        <Badge variant="outline" className="mt-0.5 shrink-0 font-mono text-xs">
                          {step.type}
                        </Badge>
                        <span className="text-muted-foreground">{step.instruction}</span>
                      </div>
                    ),
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create / Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingTemplate ? 'Edit Template' : 'Create Template'}
            </DialogTitle>
            <DialogDescription>
              {editingTemplate
                ? 'Update the template details and steps.'
                : 'Define a test template with ordered steps.'}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="template-name">Name</Label>
              <Input
                id="template-name"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="e.g. Login Flow Smoke Test"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="template-description">Description</Label>
              <Textarea
                id="template-description"
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                placeholder="What does this test verify?"
              />
            </div>

            <Separator />

            <div className="space-y-3">
              <Label>Steps</Label>
              {formSteps.map((step, index) => (
                <div
                  key={index}
                  className="space-y-2 rounded-lg border p-3"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">
                      Step {index + 1}
                    </span>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={index === 0}
                        onClick={() => moveStep(index, 'up')}
                      >
                        <ArrowUp className="size-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={index === formSteps.length - 1}
                        onClick={() => moveStep(index, 'down')}
                      >
                        <ArrowDown className="size-3" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        disabled={formSteps.length <= 1}
                        onClick={() => removeStep(index)}
                      >
                        <X className="size-3" />
                      </Button>
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-[140px_1fr]">
                    <Select
                      value={step.type}
                      onValueChange={(val) => updateStep(index, { type: val as StepType })}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="Type" />
                      </SelectTrigger>
                      <SelectContent>
                        {STEP_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>
                            {t}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      value={step.instruction}
                      onChange={(e) => updateStep(index, { instruction: e.target.value })}
                      placeholder="Instruction for the AI agent"
                    />
                  </div>
                  {step.type === 'navigate' && (
                    <Input
                      value={step.url ?? ''}
                      onChange={(e) => updateStep(index, { url: e.target.value })}
                      placeholder="URL to navigate to"
                    />
                  )}
                  {step.type === 'assertion' && (
                    <Input
                      value={step.expected ?? ''}
                      onChange={(e) => updateStep(index, { expected: e.target.value })}
                      placeholder="Expected result"
                    />
                  )}
                </div>
              ))}
              <Button variant="outline" onClick={addStep} className="w-full">
                <Plus className="mr-2 size-4" />
                Add Step
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditDialogOpen(false)}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSave}
              disabled={saving || !formName.trim() || formSteps.length === 0}
            >
              {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
              {editingTemplate ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AI Review Dialog */}
      <Dialog open={reviewDialogOpen} onOpenChange={setReviewDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Review AI-Generated Templates</DialogTitle>
            <DialogDescription>
              Select the templates you want to save. You can review the steps for
              each one before accepting.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {generatedTemplates.map((gt, idx) => (
              <div
                key={idx}
                className={`cursor-pointer rounded-lg border p-4 transition-colors ${
                  acceptedIndices.has(idx)
                    ? 'border-primary bg-primary/5'
                    : 'hover:border-muted-foreground/30'
                }`}
                onClick={() => toggleAccepted(idx)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <h4 className="font-medium">{gt.name}</h4>
                      <Badge variant="secondary">AI Generated</Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{gt.description}</p>
                  </div>
                  <div
                    className={`flex size-6 shrink-0 items-center justify-center rounded-full border-2 transition-colors ${
                      acceptedIndices.has(idx)
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/30'
                    }`}
                  >
                    {acceptedIndices.has(idx) && <Check className="size-3" />}
                  </div>
                </div>
                <div className="mt-3 space-y-1">
                  {gt.steps.map((step, sIdx) => (
                    <div key={sIdx} className="flex items-start gap-2 text-sm">
                      <Badge variant="outline" className="mt-0.5 shrink-0 font-mono text-xs">
                        {step.type}
                      </Badge>
                      <span className="text-muted-foreground">{step.instruction}</span>
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
            >
              Dismiss All
            </Button>
            <Button
              onClick={handleSaveGenerated}
              disabled={savingGenerated || acceptedIndices.size === 0}
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

'use client'

import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Loader2, ArrowUp, ArrowDown, X as XIcon, Plus } from 'lucide-react'

type StepType = 'navigate' | 'action' | 'assertion' | 'extract' | 'wait'

interface TemplateStep { order: number; instruction: string; type: StepType; url?: string; expected?: string; timeout?: number }
interface Template { id: string; project_id: string; name: string; description: string | null; steps: TemplateStep[]; source: 'manual' | 'ai_generated'; is_active: boolean; created_at: string; updated_at: string }
interface GeneratedTemplate { name: string; description: string; steps: TemplateStep[] }

const STEP_TYPES: StepType[] = ['navigate', 'action', 'assertion', 'extract', 'wait']
function emptyStep(order: number): TemplateStep { return { order, instruction: '', type: 'action' } }

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
    try { const res = await fetch(`/api/templates?projectId=${projectId}`); if (res.ok) setTemplates(await res.json()) } finally { setLoading(false) }
  }, [projectId])

  useEffect(() => { fetchTemplates() }, [fetchTemplates])

  function openCreateDialog() { setEditingTemplate(null); setFormName(''); setFormDescription(''); setFormSteps([emptyStep(1)]); setEditDialogOpen(true) }
  function openEditDialog(t: Template) { setEditingTemplate(t); setFormName(t.name); setFormDescription(t.description ?? ''); const s = Array.isArray(t.steps) ? t.steps as TemplateStep[] : []; setFormSteps(s.length > 0 ? s : [emptyStep(1)]); setEditDialogOpen(true) }

  async function handleSave() {
    setSaving(true)
    try {
      const steps = formSteps.map((s, i) => ({ ...s, order: i + 1 }))
      const url = editingTemplate ? `/api/templates/${editingTemplate.id}` : '/api/templates'
      const method = editingTemplate ? 'PATCH' : 'POST'
      const body = editingTemplate ? { name: formName, description: formDescription || null, steps } : { project_id: projectId, name: formName, description: formDescription || undefined, steps, source: 'manual' }
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (res.ok) { setEditDialogOpen(false); fetchTemplates() }
    } finally { setSaving(false) }
  }

  async function handleDelete(id: string) { const res = await fetch(`/api/templates/${id}`, { method: 'DELETE' }); if (res.ok || res.status === 204) fetchTemplates() }
  async function handleToggleActive(t: Template) { const res = await fetch(`/api/templates/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ is_active: !t.is_active }) }); if (res.ok) fetchTemplates() }

  function updateStep(i: number, u: Partial<TemplateStep>) { setFormSteps(p => p.map((s, j) => j === i ? { ...s, ...u } : s)) }
  function addStep() { setFormSteps(p => [...p, emptyStep(p.length + 1)]) }
  function removeStep(i: number) { setFormSteps(p => p.filter((_, j) => j !== i)) }
  function moveStep(i: number, dir: 'up' | 'down') { setFormSteps(p => { const n = [...p]; const s = dir === 'up' ? i - 1 : i + 1; if (s < 0 || s >= n.length) return p; [n[i], n[s]] = [n[s], n[i]]; return n }) }

  async function handleGenerate() {
    setGenerating(true)
    try { const res = await fetch('/api/templates/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId }) }); if (res.ok) { setGeneratedTemplates(await res.json()); setAcceptedIndices(new Set()); setReviewDialogOpen(true) } } finally { setGenerating(false) }
  }

  function toggleAccepted(i: number) { setAcceptedIndices(p => { const n = new Set(p); n.has(i) ? n.delete(i) : n.add(i); return n }) }

  async function handleSaveGenerated() {
    setSavingGenerated(true)
    try { await Promise.all(generatedTemplates.filter((_, i) => acceptedIndices.has(i)).map(t => fetch('/api/templates', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project_id: projectId, name: t.name, description: t.description, steps: t.steps, source: 'ai_generated' }) }))); setReviewDialogOpen(false); fetchTemplates() } finally { setSavingGenerated(false) }
  }

  if (loading) return <p className="text-sm text-muted-foreground py-12 max-w-4xl mx-auto">Loading...</p>

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-medium">Templates</h1>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleGenerate} disabled={generating}>
            {generating ? <Loader2 className="size-3.5 animate-spin" /> : null}
            AI Generate
          </Button>
          <Button size="sm" onClick={openCreateDialog}>
            <Plus className="size-3.5" />
            Create
          </Button>
        </div>
      </div>

      {templates.length === 0 ? (
        <p className="text-sm text-muted-foreground py-8">No templates yet.</p>
      ) : (
        <div className="space-y-3">
          {templates.map((t) => (
            <Card key={t.id} size="sm" className="ring-0 border border-border">
              <CardContent>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{t.name}</span>
                      {t.source === 'ai_generated' && <Badge variant="secondary">AI</Badge>}
                    </div>
                    {t.description && <p className="text-sm text-muted-foreground mt-1">{t.description}</p>}
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">Active</span>
                      <Switch checked={t.is_active} onCheckedChange={() => handleToggleActive(t)} />
                    </div>
                    <Button variant="ghost" size="xs" onClick={() => openEditDialog(t)}>Edit</Button>
                    <Button variant="ghost" size="xs" className="text-destructive hover:text-destructive" onClick={() => handleDelete(t.id)}>Delete</Button>
                  </div>
                </div>
                <div className="mt-3 space-y-1">
                  {(Array.isArray(t.steps) ? t.steps as TemplateStep[] : []).map((step, idx) => (
                    <div key={idx} className="text-sm flex gap-3">
                      <Badge variant="outline" className="text-[10px]">{step.type}</Badge>
                      <span className="text-muted-foreground">{step.instruction}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Create/Edit dialog */}
      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingTemplate ? 'Edit Template' : 'Create Template'}</DialogTitle>
            <DialogDescription>{editingTemplate ? 'Update details and steps.' : 'Define steps for this test.'}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="tpl-name">Name</Label>
              <Input id="tpl-name" value={formName} onChange={e => setFormName(e.target.value)} placeholder="Login Flow Test" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-desc">Description</Label>
              <Textarea id="tpl-desc" value={formDescription} onChange={e => setFormDescription(e.target.value)} placeholder="What does this test verify?" rows={2} />
            </div>
            <div className="space-y-3 pt-2">
              <Label>Steps</Label>
              {formSteps.map((step, i) => (
                <Card key={i} size="sm" className="ring-0 border border-border">
                  <CardContent className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">Step {i + 1}</span>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon-xs" disabled={i === 0} onClick={() => moveStep(i, 'up')}><ArrowUp className="size-3" /></Button>
                        <Button variant="ghost" size="icon-xs" disabled={i === formSteps.length - 1} onClick={() => moveStep(i, 'down')}><ArrowDown className="size-3" /></Button>
                        <Button variant="ghost" size="icon-xs" disabled={formSteps.length <= 1} onClick={() => removeStep(i)} className="text-destructive hover:text-destructive"><XIcon className="size-3" /></Button>
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                      <Select value={step.type} onValueChange={v => updateStep(i, { type: v as StepType })}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>{STEP_TYPES.map(t => <SelectItem key={t} value={t}>{t}</SelectItem>)}</SelectContent>
                      </Select>
                      <Input value={step.instruction} onChange={e => updateStep(i, { instruction: e.target.value })} placeholder="Instruction" />
                    </div>
                    {step.type === 'navigate' && <Input value={step.url ?? ''} onChange={e => updateStep(i, { url: e.target.value })} placeholder="URL" />}
                    {step.type === 'assertion' && <Input value={step.expected ?? ''} onChange={e => updateStep(i, { expected: e.target.value })} placeholder="Expected" />}
                  </CardContent>
                </Card>
              ))}
              <Button variant="outline" size="sm" onClick={addStep}>
                <Plus className="size-3.5" />
                Add step
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={saving || !formName.trim() || formSteps.length === 0}>
              {saving && <Loader2 className="mr-1 size-4 animate-spin" />}{editingTemplate ? 'Update' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* AI Review dialog */}
      <Dialog open={reviewDialogOpen} onOpenChange={setReviewDialogOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Review AI Templates</DialogTitle>
            <DialogDescription>Click to select, then save.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {generatedTemplates.map((gt, idx) => (
              <Card
                key={idx}
                size="sm"
                className={`ring-0 border cursor-pointer transition-all ${acceptedIndices.has(idx) ? 'border-primary' : 'border-border opacity-60'}`}
                onClick={() => toggleAccepted(idx)}
              >
                <CardContent>
                  <div className="flex items-center gap-2">
                    <span className="text-sm">{acceptedIndices.has(idx) ? '☑' : '☐'}</span>
                    <span className="text-sm font-medium">{gt.name}</span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">{gt.description}</p>
                  <div className="mt-2 space-y-1">
                    {gt.steps.map((s, si) => (
                      <div key={si} className="text-sm flex gap-3">
                        <Badge variant="outline" className="text-[10px]">{s.type}</Badge>
                        <span className="text-muted-foreground">{s.instruction}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewDialogOpen(false)}>Dismiss</Button>
            <Button onClick={handleSaveGenerated} disabled={savingGenerated || acceptedIndices.size === 0}>
              {savingGenerated && <Loader2 className="mr-1 size-4 animate-spin" />}Save {acceptedIndices.size}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

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
import { Loader2 } from 'lucide-react'

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

  if (loading) return <p className="text-xl opacity-50 py-12 max-w-4xl mx-auto">Loading...</p>

  return (
    <div className="max-w-4xl mx-auto space-y-10">
      <div className="flex items-center justify-between">
        <h1 className="text-4xl">Templates</h1>
        <div className="flex gap-6 text-xl">
          <button onClick={handleGenerate} disabled={generating} className="underline opacity-50 hover:opacity-100 disabled:opacity-20">
            {generating ? '...' : 'AI Generate'}
          </button>
          <button onClick={openCreateDialog} className="underline">+ Create</button>
        </div>
      </div>

      {templates.length === 0 ? (
        <p className="text-xl opacity-50 py-8">No templates yet.</p>
      ) : (
        <div className="divide-y">
          {templates.map((t) => (
            <div key={t.id} className="py-6">
              <div className="flex items-start justify-between">
                <div>
                  <span className="text-xl">{t.name}</span>
                  {t.source === 'ai_generated' && <span className="text-lg opacity-40 ml-3">AI</span>}
                  {t.description && <p className="text-lg opacity-50 mt-1">{t.description}</p>}
                </div>
                <div className="flex items-center gap-4 text-lg">
                  <div className="flex items-center gap-2">
                    <span className="opacity-40">Active</span>
                    <Switch checked={t.is_active} onCheckedChange={() => handleToggleActive(t)} />
                  </div>
                  <button onClick={() => openEditDialog(t)} className="opacity-50 hover:opacity-100">edit</button>
                  <button onClick={() => handleDelete(t.id)} className="opacity-50 hover:opacity-100 hover:text-red-700">del</button>
                </div>
              </div>
              <div className="mt-3 space-y-1">
                {(Array.isArray(t.steps) ? t.steps as TemplateStep[] : []).map((step, idx) => (
                  <div key={idx} className="text-lg flex gap-3">
                    <span className="opacity-40">{step.type}</span>
                    <span className="opacity-60">{step.instruction}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-2xl">{editingTemplate ? 'Edit Template' : 'Create Template'}</DialogTitle>
            <DialogDescription className="text-base opacity-60">{editingTemplate ? 'Update details and steps.' : 'Define steps for this test.'}</DialogDescription>
          </DialogHeader>
          <div className="space-y-6 text-xl">
            <div>
              <label className="block text-lg opacity-60 mb-2">Name</label>
              <input value={formName} onChange={e => setFormName(e.target.value)} placeholder="Login Flow Test" className="w-full border-b bg-transparent py-3 outline-none placeholder:opacity-30" />
            </div>
            <div>
              <label className="block text-lg opacity-60 mb-2">Description</label>
              <textarea value={formDescription} onChange={e => setFormDescription(e.target.value)} placeholder="What does this test verify?" rows={2} className="w-full border-b bg-transparent py-3 outline-none resize-none placeholder:opacity-30" />
            </div>
            <div className="space-y-4 pt-2">
              <span className="text-lg opacity-60">Steps</span>
              {formSteps.map((step, i) => (
                <div key={i} className="border p-4 space-y-3">
                  <div className="flex items-center justify-between text-lg">
                    <span className="opacity-50">Step {i + 1}</span>
                    <div className="flex gap-3 opacity-50">
                      <button disabled={i === 0} onClick={() => moveStep(i, 'up')} className="disabled:opacity-20">↑</button>
                      <button disabled={i === formSteps.length - 1} onClick={() => moveStep(i, 'down')} className="disabled:opacity-20">↓</button>
                      <button disabled={formSteps.length <= 1} onClick={() => removeStep(i)} className="disabled:opacity-20 hover:text-red-700">×</button>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-[160px_1fr]">
                    <Select value={step.type} onValueChange={v => updateStep(i, { type: v as StepType })}>
                      <SelectTrigger className="text-base"><SelectValue /></SelectTrigger>
                      <SelectContent>{STEP_TYPES.map(t => <SelectItem key={t} value={t} className="text-base">{t}</SelectItem>)}</SelectContent>
                    </Select>
                    <input value={step.instruction} onChange={e => updateStep(i, { instruction: e.target.value })} placeholder="Instruction" className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30" />
                  </div>
                  {step.type === 'navigate' && <input value={step.url ?? ''} onChange={e => updateStep(i, { url: e.target.value })} placeholder="URL" className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30" />}
                  {step.type === 'assertion' && <input value={step.expected ?? ''} onChange={e => updateStep(i, { expected: e.target.value })} placeholder="Expected" className="w-full border-b bg-transparent py-2 text-base outline-none placeholder:opacity-30" />}
                </div>
              ))}
              <button onClick={addStep} className="text-lg underline opacity-50 hover:opacity-100">+ Add step</button>
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

      <Dialog open={reviewDialogOpen} onOpenChange={setReviewDialogOpen}>
        <DialogContent className="sm:max-w-3xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="text-2xl">Review AI Templates</DialogTitle>
            <DialogDescription className="text-base opacity-60">Click to select, then save.</DialogDescription>
          </DialogHeader>
          <div className="divide-y text-xl">
            {generatedTemplates.map((gt, idx) => (
              <div key={idx} className={`py-5 cursor-pointer ${acceptedIndices.has(idx) ? 'opacity-100' : 'opacity-50'}`} onClick={() => toggleAccepted(idx)}>
                <div className="flex items-center gap-3">
                  <span className="text-xl">{acceptedIndices.has(idx) ? '☑' : '☐'}</span>
                  <span>{gt.name}</span>
                </div>
                <p className="text-lg opacity-50 mt-1">{gt.description}</p>
                <div className="mt-2 space-y-1">
                  {gt.steps.map((s, si) => (
                    <div key={si} className="text-lg flex gap-3"><span className="opacity-40">{s.type}</span><span className="opacity-60">{s.instruction}</span></div>
                  ))}
                </div>
              </div>
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

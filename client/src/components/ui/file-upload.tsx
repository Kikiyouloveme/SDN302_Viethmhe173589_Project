import { useEffect, useId, useRef, useState, type DragEvent } from 'react';
import { motion, useReducedMotion } from 'motion/react';
import { Check, ImagePlus, Loader2, Upload } from 'lucide-react';
import { cn } from '@/lib/utils';

interface FileUploadProps {
  accept: string;
  maxBytes: number;
  disabled?: boolean;
  uploading?: boolean;
  hint?: string;
  onChange: (file: File) => Promise<boolean>;
}

/** Single artwork upload: selection and drop share the same validation path. */
export function FileUpload({ accept, maxBytes, disabled, uploading, hint, onChange }: FileUploadProps) {
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const descriptionId = useId();
  const reducedMotion = useReducedMotion();
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  const locked = disabled || uploading;

  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function select(files: File[]) {
    if (locked || pending.current || !files.length) return;
    setError('');
    if (files.length !== 1) { setError('Vui lòng chọn một ảnh mỗi lần.'); return; }
    const next = files[0];
    if (!accept.split(',').includes(next.type)) { setError('Định dạng ảnh chưa được hỗ trợ. Chọn ảnh theo định dạng bên dưới.'); return; }
    if (next.size > maxBytes) { setError(`Ảnh vượt quá ${(maxBytes / 1024 / 1024).toFixed(0)} MB. Vui lòng chọn ảnh nhỏ hơn.`); return; }
    pending.current = true;
    try { if (await onChange(next)) setFile(next); }
    catch { setError('Chưa tải được ảnh. Vui lòng thử lại.'); }
    finally { pending.current = false; }
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void select(Array.from(event.dataTransfer.files));
  }

  return <div className="min-w-0 space-y-2">
    <motion.div
      initial={false}
      animate={{ borderColor: dragging && !locked ? 'var(--color-brand)' : 'var(--color-border)' }}
      className={cn('relative isolate overflow-hidden rounded-xl border border-dashed bg-background transition-shadow', !locked && 'hover:shadow-md', dragging && !locked && 'ring-2 ring-brand/20')}
      onDragOver={event => { event.preventDefault(); if (!locked) setDragging(true); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false); }}
      onDrop={drop}
    >
      <GridPattern />
      <input ref={input} type="file" accept={accept} disabled={locked} aria-label="Tải ảnh thiết kế" className="hidden"
        onChange={event => { void select(Array.from(event.target.files || [])); event.target.value = ''; }} />
      <motion.button type="button" disabled={locked} aria-describedby={descriptionId} aria-busy={uploading}
        onClick={() => input.current?.click()}
        whileHover={!locked && !reducedMotion ? 'hover' : undefined}
        className="relative flex w-full min-w-0 flex-col items-center px-4 py-6 text-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand disabled:cursor-not-allowed"
      >
        <span className="relative mb-5 flex size-20 items-center justify-center">
          <span aria-hidden="true" className="absolute inset-1 rounded-xl border border-dashed border-brand/40 bg-brand/5" />
          <motion.span variants={{ hover: { y: -6, rotate: -5 } }} transition={{ type: 'spring', stiffness: 260, damping: 20 }}
            className="relative flex size-20 items-center justify-center overflow-hidden rounded-xl border border-border/60 bg-background shadow-[0_8px_24px_-8px_rgba(0,0,0,0.2)]">
            {uploading ? <Loader2 aria-hidden="true" className="size-7 animate-spin text-brand motion-reduce:animate-none" /> : preview ? <img src={preview} alt="Ảnh vừa tải lên" className="size-full object-contain p-1" /> : <ImagePlus aria-hidden="true" className="size-7 text-foreground/70" strokeWidth={1.4} />}
          </motion.span>
          {file && !uploading && <span className="absolute -bottom-1 -right-1 rounded-full bg-foreground p-1 text-background"><Check aria-hidden="true" className="size-3" /></span>}
        </span>
        <span className="text-sm font-semibold">{uploading ? 'Đang tải ảnh lên…' : dragging && !locked ? 'Thả ảnh vào đây' : file ? 'Ảnh đã sẵn sàng' : 'Thêm dấu ấn của bạn'}</span>
        <span className="mt-1 max-w-full text-xs leading-relaxed text-muted-foreground">{file ? <span className="block truncate">{file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB</span> : 'Kéo thả ảnh vào đây hoặc chọn từ thiết bị'}</span>
        <span className={cn('mt-4 inline-flex items-center gap-2 rounded-lg px-4 py-2 text-xs font-semibold transition-colors', locked ? 'bg-secondary text-muted-foreground' : 'bg-foreground text-background')}>
          <Upload aria-hidden="true" className="size-3.5" />{uploading ? 'Đang xử lý' : file ? 'Chọn ảnh khác' : 'Chọn ảnh thiết kế'}
        </span>
        <span id={descriptionId} className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
          {accept.includes('image/webp') ? 'PNG, JPG, WebP' : 'PNG, JPG'} · Tối đa {(maxBytes / 1024 / 1024).toFixed(0)} MB
          {hint && <span className="block">{hint}</span>}
        </span>
      </motion.button>
    </motion.div>
    {disabled && !uploading && <p className="text-xs leading-relaxed text-muted-foreground">Xác nhận quyền sử dụng ảnh phía trên để bắt đầu.</p>}
    {error && <p role="alert" className="text-xs text-red-700">{error}</p>}
    <span role="status" className="sr-only">{uploading ? 'Đang tải ảnh lên' : file ? `Đã tải ảnh ${file.name}` : ''}</span>
  </div>;
}

export function GridPattern() {
  return <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 opacity-40 [mask-image:radial-gradient(ellipse_at_center,black,transparent_80%)]" style={{ backgroundImage: 'linear-gradient(to right, var(--color-border) 1px, transparent 1px), linear-gradient(to bottom, var(--color-border) 1px, transparent 1px)', backgroundSize: '20px 20px' }} />;
}

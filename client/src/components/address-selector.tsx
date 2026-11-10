import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, Loader2, MapPin, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { emptyLocation, matchesLocation, resolveLocation, type Location, type LocationValue } from '@/lib/location-utils';
import { loadLocations, useVietnamLocations } from '@/hooks/use-vietnam-locations';

interface Props {
  defaultValue?: Partial<LocationValue> & { district?: string };
  onChange?: (value: LocationValue) => void;
  disabled?: boolean;
}

export function AddressSelector({ defaultValue, onChange, disabled }: Props) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const initial = useRef(defaultValue);
  const changed = useRef(false);
  const notify = useRef(onChange); notify.current = onChange;
  const [value, setValue] = useState<LocationValue>(emptyLocation);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'province' | 'ward'>('province');
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [retry, setRetry] = useState(0);
  const [legacy, setLegacy] = useState('');
  const [initialError, setInitialError] = useState('');
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' });
  const provinces = useVietnamLocations('', open, retry);
  const wards = useVietnamLocations(value.provinceCode, open && !!value.provinceCode, retry);
  const source = tab === 'province' ? provinces : wards;
  const options = useMemo(() => source.data.filter(item => matchesLocation(item, query)), [source.data, query]);

  useEffect(() => {
    const old = initial.current;
    if (!old || changed.current) return;
    let active = true;
    setInitialError('');
    (async () => {
      const p = resolveLocation(await loadLocations(), old.provinceCode, old.province, 2);
      // A district-era address can refer to a different boundary with the same name.
      const w = p && (!old.district || old.wardCode)
        ? resolveLocation(await loadLocations(p.code), old.wardCode, old.ward, 5) : undefined;
      if (!active || changed.current) return;
      const next = p ? { provinceCode: p.code, province: p.name, wardCode: w?.code || '', ward: w?.name || '' } : emptyLocation;
      setValue(next); notify.current?.(next);
      if (!w) setLegacy('Địa chỉ cũ chưa xác định được theo danh mục hai cấp. Vui lòng chọn lại tỉnh/thành và phường/xã.');
    })().catch(() => { if (active && !changed.current) setInitialError('Chưa tải được danh mục để đối chiếu địa chỉ.'); });
    return () => { active = false; };
  }, [retry]);

  function close(restore = false) { setOpen(false); if (restore) trigger.current?.focus(); }
  function switchTab(next: 'province' | 'ward') {
    setTab(next); setQuery(''); setActiveIndex(0); search.current?.focus();
  }
  function choose(item: Location) {
    changed.current = true; setLegacy(''); setInitialError('');
    const next = tab === 'province'
      ? { provinceCode: item.code, province: item.name, wardCode: '', ward: '' }
      : { ...value, wardCode: item.code, ward: item.name };
    setValue(next); notify.current?.(next);
    if (tab === 'province') switchTab('ward'); else close(true);
  }

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      if (!trigger.current) return;
      const rect = trigger.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop || 0;
      const height = viewport?.height || window.innerHeight;
      const width = viewport?.width || window.innerWidth;
      const panelWidth = Math.min(Math.max(rect.width, 300), width - 24);
      const below = top + height - rect.bottom - 12;
      const above = rect.top - top - 12;
      const down = below >= 280 || below >= above;
      const maxHeight = Math.max(120, Math.min(360, down ? below : above));
      setPosition({ position: 'fixed', width: panelWidth, left: Math.max(12, Math.min(rect.left, width - panelWidth - 12)),
        top: down ? rect.bottom + 6 : Math.max(top + 6, rect.top - maxHeight - 6), maxHeight, visibility: 'visible' });
    };
    place(); search.current?.focus();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    window.visualViewport?.addEventListener('resize', place);
    window.visualViewport?.addEventListener('scroll', place);
    return () => {
      window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true);
      window.visualViewport?.removeEventListener('resize', place); window.visualViewport?.removeEventListener('scroll', place);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    const focusOutside = (event: FocusEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', outside); document.addEventListener('focusin', focusOutside);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', focusOutside); };
  }, [open]);
  useEffect(() => { panel.current?.querySelector(`#${CSS.escape(id + '-option-' + activeIndex)}`)?.scrollIntoView({ block: 'nearest' }); }, [activeIndex, id]);

  const selectedCode = tab === 'province' ? value.provinceCode : value.wardCode;
  return <div className="min-w-0 space-y-2 sm:col-span-2">
    <label htmlFor={id} className="text-sm font-medium">Tỉnh/Thành phố, Phường/Xã *</label>
    <button id={id} ref={trigger} type="button" disabled={disabled} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id + '-panel' : undefined}
      onClick={() => { if (open) close(); else { setTab(value.provinceCode ? 'ward' : 'province'); setQuery(''); setActiveIndex(0); setOpen(true); } }}
      className="flex min-h-11 w-full items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-left text-sm outline-none focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand/20 disabled:opacity-50">
      <MapPin className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className={cn('min-w-0 flex-1', !value.provinceCode && 'text-muted-foreground')}>{[value.ward, value.province].filter(Boolean).join(', ') || 'Tỉnh/TP, Phường/Xã...'}</span>
      <ChevronDown className={cn('size-4 shrink-0 transition-transform', open && 'rotate-180')} aria-hidden="true" />
    </button>
    <input type="hidden" name="provinceCode" value={value.provinceCode} />
    <input type="hidden" name="wardCode" value={value.wardCode} />
    {legacy && <p className="text-xs leading-relaxed text-muted-foreground">{legacy}</p>}
    {initialError && <p role="alert" className="text-xs text-destructive">{initialError} <button type="button" className="underline" onClick={() => setRetry(n => n + 1)}>Thử lại</button></p>}
    {open && createPortal(<div ref={panel} id={id + '-panel'} role="dialog" aria-label="Chọn địa chỉ Việt Nam" style={position}
      className="z-[200] flex flex-col overflow-hidden rounded-xl border border-border bg-background shadow-xl"
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
      }}>
      <div className="shrink-0 p-3 pb-2"><div className="flex items-center gap-2 rounded-md border border-border px-3 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/15">
        <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <input ref={search} role="combobox" aria-label={tab === 'province' ? 'Tìm tỉnh/thành phố' : 'Tìm phường/xã'} aria-expanded="true" aria-autocomplete="list" aria-controls={id + '-list'} aria-activedescendant={options[activeIndex] ? id + '-option-' + activeIndex : undefined}
          placeholder={tab === 'province' ? 'Tìm tỉnh/thành phố...' : 'Tìm phường/xã...'} value={query}
          className="h-11 min-w-0 flex-1 bg-transparent text-base outline-none sm:text-sm"
          onChange={event => { setQuery(event.target.value); setActiveIndex(0); }}
          onKeyDown={event => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); setActiveIndex(i => Math.max(0, Math.min(options.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1))));
            } else if (event.key === 'Enter') { event.preventDefault(); if (options[activeIndex]) choose(options[activeIndex]); }
          }} />
      </div></div>
      <div role="tablist" aria-label="Cấp hành chính" className="flex shrink-0 border-b border-border px-3">
        {(['province', 'ward'] as const).map(key => <button key={key} type="button" role="tab" id={id + '-' + key} aria-selected={tab === key} aria-controls={id + '-list'} disabled={key === 'ward' && !value.provinceCode}
          onClick={() => switchTab(key)} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight'].includes(event.key)) { event.preventDefault(); if (value.provinceCode) switchTab(key === 'province' ? 'ward' : 'province'); } }}
          className={cn('min-h-11 flex-1 border-b-2 text-sm font-medium outline-none focus-visible:bg-secondary disabled:opacity-40', tab === key ? 'border-brand text-brand' : 'border-transparent text-muted-foreground hover:text-foreground')}>{key === 'province' ? 'Tỉnh / TP' : 'Phường / Xã'}</button>)}
      </div>
      {tab === 'ward' && <p className="shrink-0 px-4 pt-2 text-xs text-muted-foreground">{value.province}</p>}
      {source.loading ? <p role="status" className="flex items-center justify-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />Đang tải danh mục…</p>
        : source.error ? <div role="alert" className="p-4 text-sm"><p>Không tải được danh mục địa chỉ. Vui lòng thử lại.</p><button type="button" className="mt-2 min-h-11 text-brand underline" onClick={() => setRetry(n => n + 1)}>Thử lại</button></div>
        : !options.length ? <p role="status" className="p-6 text-center text-sm text-muted-foreground">Không có kết quả phù hợp.</p> : null}
      <div id={id + '-list'} role="listbox" aria-label={tab === 'province' ? 'Tỉnh/Thành phố' : 'Phường/Xã'} aria-busy={source.loading} className="min-h-0 overflow-y-auto overscroll-contain p-2">
        {!source.error && !source.loading && options.map((item, index) => <button key={item.code} id={id + '-option-' + index} type="button" role="option" aria-selected={selectedCode === item.code} tabIndex={-1}
          onMouseDown={event => event.preventDefault()} onClick={() => choose(item)}
          className={cn('flex min-h-11 w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm hover:bg-secondary', index === activeIndex && 'bg-secondary/60', selectedCode === item.code && 'font-medium text-brand')}>
          {item.name}{selectedCode === item.code && <Check className="size-4 shrink-0" aria-hidden="true" />}
        </button>)}
      </div>
    </div>, trigger.current?.closest('[role="dialog"]') || document.body)}
  </div>;
}

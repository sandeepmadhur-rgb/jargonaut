import { useState, useEffect, useCallback, useRef } from 'react'

const INTERVALS = [5, 10, 15, 30, 60]
const START_HOUR = 8
const END_HOUR = 18
const FETCH_TIMEOUT_MS = 20000
const RETRY_DELAY_MS = 1500
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000

// ─── Persistence helpers ────────────────────────────────────────────────────

function loadUsedWords() {
  try {
    const raw = localStorage.getItem('jargonaut_used')
    if (!raw) return new Set()
    const entries = JSON.parse(raw)
    const now = Date.now()
    const fresh = entries.filter(e => now - e.ts < SEVEN_DAYS_MS)
    if (fresh.length !== entries.length) {
      localStorage.setItem('jargonaut_used', JSON.stringify(fresh))
    }
    return new Set(fresh.map(e => e.word.toLowerCase()))
  } catch {
    return new Set()
  }
}

function persistUsedWord(word) {
  try {
    const raw = localStorage.getItem('jargonaut_used')
    const entries = raw ? JSON.parse(raw) : []
    entries.push({ word: word.toLowerCase(), ts: Date.now() })
    localStorage.setItem('jargonaut_used', JSON.stringify(entries))
  } catch {}
}

function getSlotCache(key) {
  try {
    const raw = localStorage.getItem(`jargonaut_slot_${key}`)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function setSlotCache(key, data) {
  try {
    localStorage.setItem(`jargonaut_slot_${key}`, JSON.stringify(data))
  } catch {}
}

function loadHistory() {
  try {
    const raw = localStorage.getItem(`jargonaut_hist_${new Date().toDateString()}`)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveHistory(hist) {
  try {
    localStorage.setItem(`jargonaut_hist_${new Date().toDateString()}`, JSON.stringify(hist))
  } catch {}
}

// ─── Module-level state ──────────────────────────────────────────────────────

const wordCache = new Map()
const usedWords = loadUsedWords()   // pre-loaded from localStorage on first import

// ─── Slot logic ──────────────────────────────────────────────────────────────

function getTodayStr() { return new Date().toDateString() }

function getSlotInfo(mins) {
  const now = new Date()
  const total = now.getHours() * 60 + now.getMinutes()
  const start = START_HOUR * 60
  const end = END_HOUR * 60
  if (total < start || total >= end) {
    const next = new Date()
    if (total >= end) next.setDate(next.getDate() + 1)
    next.setHours(START_HOUR, 0, 0, 0)
    return { inWindow: false, slotKey: null, secs: Math.floor((next - now) / 1000) }
  }
  const idx = Math.floor((total - start) / mins)
  const endMin = start + (idx + 1) * mins
  const slotEnd = new Date()
  slotEnd.setHours(Math.floor(endMin / 60), endMin % 60, 0, 0)
  return {
    inWindow: true,
    slotKey: `${getTodayStr()}-${mins}-${idx}`,
    secs: Math.max(0, Math.floor((slotEnd - now) / 1000))
  }
}

// ─── API call ────────────────────────────────────────────────────────────────

async function fetchWord(exclude = []) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch('/api/word', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({ exclude })
    })
    if (!r.ok) throw new Error(`${r.status}`)
    return await r.json()
  } finally {
    clearTimeout(timeout)
  }
}

const sleep = ms => new Promise(res => setTimeout(res, ms))

// ─── Styles ──────────────────────────────────────────────────────────────────

const C = {
  bg:        '#0c0c0c',
  card:      '#141414',
  border:    '#222222',
  borderMid: '#2e2e2e',
  word:      '#d6d2cb',
  primary:   '#b8b4ad',
  secondary: '#7a7673',
  tertiary:  '#524f4d',
  activeBg:  '#1e1e1e',
  activeTxt: '#a8a49e',
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function App() {
  const [intervalMins, setIntervalMins] = useState(
    () => parseInt(localStorage.getItem('jargonaut_interval') || '15')
  )
  const [wordData, setWordData]     = useState(null)
  const [loading, setLoading]       = useState(false)
  const [errorMsg, setErrorMsg]     = useState(null)
  const [secs, setSecs]             = useState(null)
  const [inWindow, setInWindow]     = useState(true)
  const [history, setHistory]       = useState(() => loadHistory())
  const [showHistory, setShowHistory] = useState(false)
  const [pendingInterval, setPendingInterval] = useState(null)
  const [retrying, setRetrying]     = useState(false)

  const slotRef    = useRef(null)
  const loadingFor = useRef(null)

  const loadOrFetch = useCallback(async (key, isRetry = false) => {
    // In-memory cache
    if (wordCache.has(key)) {
      setWordData(wordCache.get(key))
      setLoading(false)
      setErrorMsg(null)
      return
    }
    // localStorage cache (survives page refresh)
    const persisted = getSlotCache(key)
    if (persisted) {
      wordCache.set(key, persisted)
      setWordData(persisted)
      setLoading(false)
      setErrorMsg(null)
      return
    }

    if (isRetry) {
      setRetrying(true)
      await sleep(RETRY_DELAY_MS)
      setRetrying(false)
    }

    loadingFor.current = key
    setLoading(true)
    setErrorMsg(null)

    try {
      let data = await fetchWord([...usedWords])

      // Client-side duplicate safety net
      if (usedWords.has(data.word.toLowerCase())) {
        usedWords.add(data.word.toLowerCase())
        data = await fetchWord([...usedWords])
      }

      if (loadingFor.current !== key) return

      wordCache.set(key, data)
      setSlotCache(key, data)
      usedWords.add(data.word.toLowerCase())
      persistUsedWord(data.word)

      setWordData(data)
      setErrorMsg(null)
      setHistory(prev => {
        if (prev.find(h => h.key === key)) return prev
        const next = [{ key, word: data.word, def: data.definition }, ...prev].slice(0, 20)
        saveHistory(next)
        return next
      })
      setLoading(false)
    } catch (e) {
      if (loadingFor.current !== key) return
      setErrorMsg(e.name === 'AbortError' ? 'Request timed out.' : 'Couldn\'t fetch your word.')
      setLoading(false)
    }
  }, [])

  const tick = useCallback(() => {
    const { inWindow: iw, slotKey, secs: s } = getSlotInfo(intervalMins)
    setInWindow(iw)
    setSecs(s)
    if (iw && slotKey !== slotRef.current) {
      slotRef.current = slotKey
      loadOrFetch(slotKey)
    }
    if (!iw) { slotRef.current = null; setWordData(null) }
  }, [intervalMins, loadOrFetch])

  useEffect(() => {
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [tick])

  const fmt = s => s === null ? '' : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  const confirmSwitch = () => {
    const m = pendingInterval
    setPendingInterval(null)
    slotRef.current = null
    setWordData(null)
    setErrorMsg(null)
    localStorage.setItem('jargonaut_interval', String(m))
    setIntervalMins(m)
  }

  const handleRetry = () => {
    if (!slotRef.current || retrying || loading) return
    wordCache.delete(slotRef.current)
    loadOrFetch(slotRef.current, true)
  }

  const s = {
    wrap:            { padding: '1.5rem 1.25rem 3rem', maxWidth: 420, margin: '0 auto', fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif", background: C.bg, minHeight: '100vh' },
    header:          { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.75rem' },
    appName:         { fontSize: 11, fontWeight: 600, letterSpacing: '0.14em', color: C.tertiary, textTransform: 'uppercase' },
    countdown:       { fontSize: 12, color: C.tertiary },
    confirm:         { background: C.card, border: `1px solid ${C.borderMid}`, borderRadius: 12, padding: '1rem 1.25rem', marginBottom: '1.25rem' },
    confirmText:     { fontSize: 14, color: C.secondary, marginBottom: 12, lineHeight: 1.45 },
    confirmBtns:     { display: 'flex', gap: 8 },
    btnCancel:       { flex: 1, padding: '8px 0', fontSize: 13, cursor: 'pointer', background: 'transparent', border: `1px solid ${C.borderMid}`, borderRadius: 8, color: C.secondary, fontFamily: 'inherit' },
    btnOk:           { flex: 1, padding: '8px 0', fontSize: 13, cursor: 'pointer', background: C.activeBg, border: `1px solid ${C.borderMid}`, borderRadius: 8, color: C.primary, fontFamily: 'inherit', fontWeight: 500 },
    card:            { background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: '1.5rem', marginBottom: '1.25rem' },
    wordText:        { fontSize: 38, fontWeight: 300, color: C.word, letterSpacing: '-0.03em', lineHeight: 1.05, marginBottom: 8, fontFamily: "Georgia, 'Times New Roman', serif" },
    syllables:       { fontSize: 15, fontWeight: 600, color: C.primary, marginBottom: 1 },
    ipa:             { fontSize: 12, fontFamily: "'Courier New', Courier, monospace", color: C.secondary, marginBottom: 16 },
    tipLabel:        { fontSize: 10, color: C.tertiary, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 8 },
    tipRow:          { display: 'flex', gap: 10, alignItems: 'baseline', marginBottom: 5 },
    tipSyl:          { fontSize: 13, fontStyle: 'italic', fontWeight: 600, color: C.primary, minWidth: 52, flexShrink: 0 },
    tipHint:         { fontSize: 13, color: C.secondary, lineHeight: 1.4 },
    divider:         { borderTop: `1px solid ${C.border}`, margin: '16px 0' },
    secLabel:        { fontSize: 10, color: C.tertiary, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 },
    definition:      { fontSize: 14, color: C.primary, lineHeight: 1.6, marginBottom: 14 },
    usage:           { fontSize: 13, color: C.secondary, fontStyle: 'italic', lineHeight: 1.6 },
    statusCard:      { background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: '2.5rem', textAlign: 'center', marginBottom: '1.25rem', color: C.secondary, fontSize: 14 },
    intervalRow:     { display: 'flex', gap: 6, marginBottom: '1.25rem' },
    iBtn: a =>       ({ flex: 1, padding: '9px 0', fontSize: 13, fontWeight: a ? 600 : 400, background: a ? C.activeBg : 'transparent', border: `1px solid ${a ? C.borderMid : C.border}`, borderRadius: 9, color: a ? C.activeTxt : C.tertiary, cursor: 'pointer', fontFamily: 'inherit' }),
    outside:         { textAlign: 'center', padding: '3rem 0' },
    outsideTitle:    { fontSize: 17, fontWeight: 500, color: C.primary, marginBottom: 6 },
    outsideSub:      { fontSize: 13, color: C.tertiary, lineHeight: 1.6 },
    histToggle:      { display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', padding: '4px 0', fontSize: 13, color: C.tertiary, cursor: 'pointer', marginBottom: 8, fontFamily: 'inherit', width: '100%', textAlign: 'left' },
    histItem:        { display: 'flex', gap: 10, alignItems: 'baseline', padding: '8px 0', borderBottom: `1px solid ${C.border}` },
    histWord:        { fontSize: 14, fontWeight: 600, color: C.primary, minWidth: 120, flexShrink: 0 },
    histDef:         { fontSize: 12, color: C.secondary, flex: 1, lineHeight: 1.4 },
    retryBtn:        { cursor: 'pointer', fontFamily: 'inherit', background: 'transparent', border: `1px solid ${C.borderMid}`, borderRadius: 8, padding: '7px 20px', color: C.secondary, fontSize: 13, marginTop: 4, opacity: (retrying || loading) ? 0.4 : 1 },
  }

  const isError = !!errorMsg && !loading && !retrying

  return (
    <div style={s.wrap}>
      {pendingInterval && (
        <div style={s.confirm}>
          <p style={s.confirmText}>Switching to {pendingInterval}-min intervals will replace your current word.</p>
          <div style={s.confirmBtns}>
            <button style={s.btnCancel} onClick={() => setPendingInterval(null)}>Cancel</button>
            <button style={s.btnOk} onClick={confirmSwitch}>Switch anyway</button>
          </div>
        </div>
      )}

      <div style={s.header}>
        <span style={s.appName}>Jargonaut</span>
        {inWindow && secs !== null && <span style={s.countdown}>next word in {fmt(secs)}</span>}
      </div>

      {!inWindow && (
        <div style={s.outside}>
          <p style={s.outsideTitle}>No active meeting window</p>
          <p style={s.outsideSub}>Words rotate 8am–6pm in your local time.{secs !== null && ` Opens in ${fmt(secs)}.`}</p>
        </div>
      )}

      {inWindow && (loading || retrying) && (
        <div style={s.statusCard}>{retrying ? 'Retrying in a moment…' : 'Fetching your word…'}</div>
      )}

      {inWindow && isError && (
        <div style={s.statusCard}>
          <p style={{ marginBottom: 14 }}>{errorMsg}</p>
          <button style={s.retryBtn} onClick={handleRetry}>Try again</button>
        </div>
      )}

      {inWindow && wordData && !loading && !retrying && !isError && (
        <div style={s.card}>
          <p style={s.wordText}>{wordData.word}</p>
          <p style={s.syllables}>{wordData.syllables}</p>
          <p style={s.ipa}>{wordData.ipa}</p>
          <p style={s.tipLabel}>Think of it like</p>
          {wordData.pronunciationTips?.map((t, i) => (
            <div key={i} style={s.tipRow}>
              <span style={s.tipSyl}>"{t.syllable}"</span>
              <span style={s.tipHint}>{t.hint}</span>
            </div>
          ))}
          <div style={s.divider} />
          <p style={s.secLabel}>Definition</p>
          <p style={s.definition}>{wordData.definition}</p>
          <p style={s.secLabel}>Try saying</p>
          <p style={s.usage}>"{wordData.businessUsage}"</p>
        </div>
      )}

      <div style={s.intervalRow}>
        {INTERVALS.map(m => (
          <button key={m} style={s.iBtn(m === intervalMins)} onClick={() => { if (m !== intervalMins) setPendingInterval(m) }}>
            {m}m
          </button>
        ))}
      </div>

      {history.length > 0 && (
        <div>
          <button style={s.histToggle} onClick={() => setShowHistory(h => !h)}>
            <span style={{ fontSize: 9, display: 'inline-block', transform: showHistory ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▶</span>
            Today's words ({history.length})
          </button>
          {showHistory && history.map((item, i) => (
            <div key={i} style={s.histItem}>
              <span style={s.histWord}>{item.word}</span>
              <span style={s.histDef}>{item.def}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  AppProvider,
  Page,
  LegacyCard,
  Text,
  TextField,
  Select,
  Button,
  InlineStack,
  Tabs,
} from '@shopify/polaris';
import '@shopify/polaris/build/esm/styles.css';

function App() {
  // API ana makinesi (dev/test için) ve mağaza domaini
  const [apiHost, setApiHost] = useState('http://localhost:8082');
  const [shop, setShop] = useState('test.myshopify.com');
  // Tab seçimi: Presence veya KPI Dashboard
  const [selectedTab, setSelectedTab] = useState(0);
  // Tier seçimi: Tier-1 (proxy-poll) veya Tier-2 (sse)
  const [mode, setMode] = useState<'proxy-poll' | 'sse'>('proxy-poll');
  // Smoothing parametreleri
  const [strategy, setStrategy] = useState('raw');
  // Sayaç/metrik durumları
  const [current, setCurrent] = useState(0);
  const [display, setDisplay] = useState(0);
  const [status, setStatus] = useState<'idle' | 'connecting' | 'open' | 'error'>('idle');
  const [lastError, setLastError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<number | null>(null);

  // SSE için akış URL'si (Tier-2)
  const streamUrl = useMemo(() => {
    const base = apiHost.replace(/\/+$/, '');
    const u = new URL(`${base}/presence/stream`);
    u.searchParams.set('shop', shop);
    u.searchParams.set('strategy', strategy);
    return u.toString();
  }, [apiHost, shop, strategy]);

  // Tier-2: SSE bağlantısı kurar
  const connect = () => {
    setStatus('connecting');
    setLastError(null);
    esRef.current?.close();
    const es = new EventSource(streamUrl);
    es.onopen = () => {
      setStatus('open');
    };
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        setCurrent(Number(data.current || 0));
        setDisplay(Number(data.display || 0));
      } catch {}
    };
    es.onerror = (e) => {
      setStatus('error');
      setLastError('Stream connection error');
      es.close();
    };
    esRef.current = es;
  };

  // Tier-1: App Proxy polling URL'si
  const proxyPresenceUrl = useMemo(() => {
    const base = apiHost.replace(/\/+$/, '');
    const u = new URL(`${base}/app-proxy/presence`);
    u.searchParams.set('shop', shop);
    u.searchParams.set('dev', '1');
    return u.toString();
  }, [apiHost, shop]);

  // Tier-1: Polling başlatır
  const startPolling = () => {
    stopPolling();
    setStatus('connecting');
    setLastError(null);
    const run = async () => {
      try {
        const r = await fetch(proxyPresenceUrl, { cache: 'no-store' });
        if (r.status === 304) {
          // Değişiklik yok
        } else if (r.ok) {
          const d = await r.json();
          setCurrent(Number(d.current || 0));
          setDisplay(Number(d.display || 0));
          setStatus('open');
        } else {
          setStatus('error');
          setLastError(`HTTP ${r.status}: ${r.statusText}`);
        }
      } catch (e: any) {
        setStatus('error');
        setLastError(e?.message || 'polling error');
      }
    };
    const schedule = () => {
      const base = document.hidden ? 30000 : 10000;
      const jitter = Math.floor(Math.random() * 3000);
      pollTimerRef.current = window.setTimeout(async () => {
        await run();
        schedule();
      }, base + jitter);
    };
    run();
    schedule();
  };

  const stopPolling = () => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  };

  // Mod değişimlerinde uygun taşıyıcıyı başlat/durdur
  useEffect(() => {
    if (mode === 'sse') {
      stopPolling();
      connect();
      return () => esRef.current?.close();
    } else {
      esRef.current?.close();
      startPolling();
      return () => stopPolling();
    }
  }, [mode, streamUrl, proxyPresenceUrl]);

  // Sekme görünürlüğü değiştiğinde polling periyodunu uyarlamak için tetikleyici
  useEffect(() => {
    const onVis = () => {
      if (mode === 'proxy-poll') {
        startPolling();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [mode, proxyPresenceUrl]);

  const tabs = [
    {
      id: 'presence',
      content: 'Aktif Kullanıcılar',
      panel: (
        <>
          <LegacyCard sectioned>
            <Text as="p" variant="headingMd">
              Active Users
            </Text>
            <div style={{ fontSize: 36, fontWeight: 700 }}>{display}</div>
            <div style={{ color: '#666' }}>
              current: {current} | display: {display}
            </div>
            <div
              style={{
                marginTop: 8,
                color: status === 'error' ? '#d72c0d' : status === 'open' ? '#007f5f' : '#666',
              }}
            >
              Status: {status}
              {lastError ? ` — ${lastError}` : ''}
            </div>
          </LegacyCard>

          <LegacyCard sectioned>
            <InlineStack gap="400" align="start">
              <TextField
                label="API Host"
                value={apiHost}
                onChange={setApiHost}
                autoComplete="off"
              />
              <TextField label="Shop" value={shop} onChange={setShop} autoComplete="off" />
              <Select
                label="Mode"
                options={[
                  { label: 'Tier-1: App Proxy (Polling)', value: 'proxy-poll' },
                  { label: 'Tier-2: SSE (API Host)', value: 'sse' },
                ]}
                value={mode}
                onChange={(v) => setMode(v as any)}
              />
            </InlineStack>
            <div style={{ height: 12 }} />
            <InlineStack gap="400" align="start">
              <Select
                label="Strategy"
                options={[
                  { label: 'Raw', value: 'raw' },
                ]}
                value={strategy}
                onChange={setStrategy}
              />
            </InlineStack>
            <div style={{ height: 12 }} />
            <Button
              onClick={() => {
                mode === 'sse' ? connect() : startPolling();
              }}
            >
              Reconnect
            </Button>
            <Button
              onClick={async () => {
                try {
                  const res = await fetch(`${apiHost}/health`);
                  alert(`Health: ${res.status} ${res.ok ? 'OK' : 'FAIL'}`);
                } catch (err: any) {
                  alert(`Health request failed: ${err?.message || String(err)}`);
                }
              }}
            >
              Test API Host
            </Button>
          </LegacyCard>
        </>
      ),
    },
  ];

  return (
    <AppProvider i18n={{}}>
      <div style={{ minHeight: '100vh', backgroundColor: '#f6f6f7' }}>
        <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
          {tabs[selectedTab].panel}
        </Tabs>
      </div>
    </AppProvider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);

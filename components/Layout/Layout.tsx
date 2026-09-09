import React from 'react';
import { useRouter } from 'next/router';

interface LayoutProps {
  children: React.ReactNode;
}

const NAV_ITEMS = [
  { href: '/', label: 'Crypto', icon: '₿' },
  { href: '/idx', label: 'IDX / IHSG', icon: '🇮🇩' },
];

export default function Layout({ children }: LayoutProps) {
  const router = useRouter();

  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
    }}>
      <header style={{
        background: 'rgba(17, 24, 39, 0.95)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid #374151',
        padding: '12px 24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        position: 'sticky',
        top: 0,
        zIndex: 100,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <div style={{
            width: '32px',
            height: '32px',
            background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
            borderRadius: '8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 'bold',
            fontSize: '14px',
            color: 'white',
          }}>
            AH
          </div>
          <div>
            <h1 style={{ fontSize: '16px', fontWeight: '700', color: '#f9fafb', margin: 0 }}>
              Althunter
            </h1>
            <p style={{ fontSize: '11px', color: '#6b7280', margin: 0 }}>
              Relative Strength Decoupling Detector
            </p>
          </div>
        </div>

        <nav style={{ display: 'flex', gap: '4px' }}>
          {NAV_ITEMS.map((item) => {
            const isActive = router.pathname === item.href;
            return (
              <button
                key={item.href}
                onClick={() => router.push(item.href)}
                style={{
                  padding: '6px 14px',
                  borderRadius: '6px',
                  border: 'none',
                  background: isActive ? 'rgba(59, 130, 246, 0.2)' : 'transparent',
                  color: isActive ? '#3b82f6' : '#9ca3af',
                  fontSize: '12px',
                  fontWeight: '600',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  transition: 'all 0.15s',
                }}
              >
                <span>{item.icon}</span>
                {item.label}
              </button>
            );
          })}
        </nav>

        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{
            padding: '4px 10px',
            background: 'rgba(16, 185, 129, 0.15)',
            border: '1px solid rgba(16, 185, 129, 0.3)',
            borderRadius: '6px',
            fontSize: '11px',
            color: '#10b981',
            fontWeight: '600',
          }}>
            LIVE
          </div>
        </div>
      </header>
      <main style={{
        flex: 1,
        padding: '20px 24px',
        maxWidth: '1400px',
        width: '100%',
        margin: '0 auto',
      }}>
        {children}
      </main>
      <footer style={{
        padding: '12px 24px',
        borderTop: '1px solid #374151',
        textAlign: 'center',
        fontSize: '11px',
        color: '#6b7280',
      }}>
        Althunter v2.0 — Relative Strength Decoupling Hunter
      </footer>
    </div>
  );
}
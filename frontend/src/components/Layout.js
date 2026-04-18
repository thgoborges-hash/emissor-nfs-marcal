import React from 'react';
import { Outlet } from 'react-router-dom';
import Navbar from './Navbar';
import CommandPalette from './CommandPalette';

// Layout com menu superior (em vez de lateral)
export function LayoutEscritorio() {
  return (
    <div className="app-layout-top">
      <Navbar />
      <main className="main-content-top">
        <Outlet />
      </main>
      <CommandPalette />
    </div>
  );
}

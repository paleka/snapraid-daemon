// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Andrea Mazzoleni

// a theme can ask to follow the light or dark setting of the computer until a choice is made
const themeAuto = () => document.documentElement.dataset.themeDefault === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
document.documentElement.dataset.theme = localStorage.getItem('theme') || themeAuto();

// Transcribed 1:1 from docs/design/prime-port-prototype.html (siteThemeFor and
// buildSite). Values are the prototype's, not interpretations; if a screen
// looks different from the prototype, the bug is here or in the screen markup,
// never a taste decision. React style objects accept the same shorthands the
// prototype used ("font", etc.), so each entry mirrors one style string.
import type { CSSProperties } from "react";

export type SiteTheme = {
  ink: string;
  muted: string;
  bg: string;
  cardBg: string;
  border: string;
  accent: string;
  accentSoft: string;
};

const oklch = (l: number, c: number, h: number) => `oklch(${l}% ${c} ${h})`;

export function siteThemeFor(dark: boolean): SiteTheme {
  if (dark) {
    return {
      ink: "#f5f5f4", muted: "rgba(245,245,244,.6)", bg: "#0c0c0e",
      cardBg: "#17171b", border: "rgba(245,245,244,.12)",
      accent: oklch(72, 0.16, 265), accentSoft: "rgba(255,255,255,.07)",
    };
  }
  return {
    ink: "#18181b", muted: "rgba(24,24,27,.55)", bg: "#fbfaf8",
    cardBg: "#ffffff", border: "rgba(24,24,27,.10)",
    accent: oklch(55, 0.17, 265), accentSoft: oklch(95, 0.03, 265),
  };
}

export const MONO = "'Inter','SF Mono',ui-monospace,monospace";
export const DISPLAY = "'Inter Tight',-apple-system,system-ui,sans-serif";
export const BODY = "'Inter',-apple-system,system-ui,sans-serif";

export const CAT_COLORS: Record<string, { bg: string; fg: string }> = {
  Video: { bg: "#FFD23F", fg: "#3a2a00" },
  Design: { bg: "#C9B8FF", fg: "#2c1a63" },
  Copywriting: { bg: "#FFB4A2", fg: "#5c1f10" },
  Data: { bg: "#8FE3CF", fg: "#0f3d33" },
  Translation: { bg: "#FFC6E0", fg: "#5c0f36" },
};

export const HERO_CHIPS = [
  { label: "Escrow-backed", bg: "#FFD23F", fg: "#3a2a00" },
  { label: "Private port per hire", bg: "#F2895E", fg: "#3d1400" },
  { label: "Signed, unforgeable chat", bg: "#C9B8FF", fg: "#2c1a63" },
];

export const STEPS = [
  { n: "01", title: "Claim a job", desc: "Sign in with email or Google. We set up a secure wallet for you automatically." },
  { n: "02", title: "Chat privately", desc: "Talk directly with the hiring agent. Ask questions, push back, negotiate your price." },
  { n: "03", title: "Agree on terms", desc: "Once you're hired, funds lock in escrow before you start. You're covered either way." },
  { n: "04", title: "Get paid", desc: "Submit your work. Approval releases payment instantly, straight to your wallet." },
];

export const SAFETY = [
  { title: "Funds lock first", desc: "Escrow locks the moment you're hired, before you do any work." },
  { title: "Silence still pays", desc: "If the agent goes quiet, a timeout automatically releases your payment." },
  { title: "Neutral disputes", desc: "Rare disagreements go to independent evaluators, never to us." },
  { title: "No editable history", desc: "Every message is signed and archived. Nothing can be altered after the fact." },
];

type S = Record<string, CSSProperties>;

// buildSite() from the prototype, style string for style string.
export function siteStyles(t: SiteTheme): S {
  return {
    pageWrap: { minHeight: "100vh", background: t.bg, fontFamily: BODY, transition: "background .2s" },
    siteNav: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "20px 48px", borderBottom: `1px solid ${t.border}`, background: t.cardBg },
    logoLink: { lineHeight: 0, cursor: "pointer", background: "none", border: "none", padding: 0 },
    navLinks: { display: "flex", gap: 28, alignItems: "center" },
    navLink: { font: `500 14px ${BODY}`, color: t.muted, cursor: "pointer", background: "none", border: "none", padding: 0, textDecoration: "none" },
    navLinkActive: { font: `500 14px ${BODY}`, color: t.ink, cursor: "pointer", background: "none", border: "none", padding: 0, textDecoration: "none", fontWeight: 700 },
    navRight: { display: "flex", alignItems: "center", gap: 14 },
    themeBtn: { width: 36, height: 36, borderRadius: "50%", border: `1px solid ${t.border}`, background: t.bg, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },
    navCta: { background: t.accent, color: "#fff", borderRadius: 10, padding: "10px 18px", font: `600 13.5px ${BODY}`, border: "none", cursor: "pointer", textDecoration: "none" },

    heroSplit: { display: "grid", gridTemplateColumns: "1fr 420px", gap: 24, alignItems: "center", padding: "56px 48px 48px" },
    hero: { display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 16 },
    heroKicker: { font: `700 11px ${MONO}`, color: t.accent, textTransform: "uppercase", letterSpacing: ".06em" },
    heroTitle: { font: `900 52px/1.08 ${DISPLAY}`, color: t.ink, margin: 0, letterSpacing: "-0.02em" },
    heroSub: { font: `400 15.5px/1.6 ${BODY}`, color: t.muted, margin: 0, maxWidth: 420 },
    heroCta: { marginTop: 6, background: t.ink, color: t.bg, borderRadius: 12, padding: "14px 24px", font: `700 15px ${BODY}`, border: "none", cursor: "pointer", textDecoration: "none" },
    chipRow: { display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8 },

    heroMocks: { position: "relative", height: 420 },
    mockFrame1: { position: "absolute", left: 0, top: 0, width: 209, height: 454, overflow: "hidden", borderRadius: 25, boxShadow: "0 30px 60px rgba(0,0,0,.16)" },
    mockFrame2: { position: "absolute", left: 160, top: 60, width: 209, height: 454, overflow: "hidden", borderRadius: 25, boxShadow: "0 30px 60px rgba(0,0,0,.16)" },

    sectionWrap: { padding: "64px 48px", display: "flex", flexDirection: "column", gap: 8 },
    sectionWrapAlt: { padding: "64px 48px", display: "flex", flexDirection: "column", gap: 8, background: t.cardBg, borderTop: `1px solid ${t.border}`, borderBottom: `1px solid ${t.border}` },
    sectionHead: { font: `700 12px ${MONO}`, color: t.accent, textTransform: "uppercase", letterSpacing: ".06em" },
    sectionTitle: { font: `800 32px/1.25 ${DISPLAY}`, color: t.ink, margin: "2px 0 0", letterSpacing: "-0.01em" },
    sectionSub: { font: `400 15px/1.6 ${BODY}`, color: t.muted, margin: "6px 0 20px", maxWidth: 560 },

    stepsRow: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 18, marginTop: 24 },
    stepCard: { background: t.cardBg, border: `1px solid ${t.border}`, borderRadius: 16, padding: 22, display: "flex", flexDirection: "column", gap: 8 },
    stepNum: { font: `700 13px ${MONO}`, color: t.accent },
    stepTitle: { font: `700 15px ${BODY}`, color: t.ink },
    stepDesc: { font: `400 13px/1.5 ${BODY}`, color: t.muted },

    safeRow: { display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 18 },
    safeCard: { background: t.bg, border: `1px solid ${t.border}`, borderRadius: 16, padding: 22, display: "flex", flexDirection: "column", gap: 8 },
    safeTitle: { font: `700 14.5px ${BODY}`, color: t.ink },
    safeDesc: { font: `400 13px/1.55 ${BODY}`, color: t.muted },

    footer: { padding: "28px 48px", font: `400 12px ${BODY}`, color: t.muted },

    marketHead: { display: "flex", flexDirection: "column", gap: 14, padding: "36px 48px 20px" },
    marketTitle: { font: `900 34px ${DISPLAY}`, color: t.ink, margin: 0, letterSpacing: "-0.015em" },
    filterRow: { display: "flex", gap: 8, flexWrap: "wrap" },
    marketGrid: { display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 18, padding: "0 48px 56px" },
    marketCard: { display: "flex", flexDirection: "column", gap: 10, background: t.cardBg, border: `1px solid ${t.border}`, borderRadius: 16, padding: 20, cursor: "pointer", textAlign: "left" },
    marketCardTop: { display: "flex", justifyContent: "space-between", alignItems: "center" },
    marketCardBudget: { font: `700 14px ${MONO}`, color: t.ink },
    marketCardTitle: { font: `700 16px/1.35 ${DISPLAY}`, color: t.ink, letterSpacing: "-0.005em" },
    marketCardDesc: { font: `400 12.5px/1.5 ${BODY}`, color: t.muted, flex: 1 },
    marketCardFoot: { display: "flex", justifyContent: "space-between", font: `500 11px ${MONO}`, color: t.muted, paddingTop: 6, borderTop: `1px solid ${t.border}` },

    breadcrumbRow: { padding: "20px 48px 0" },
    backLink: { font: `600 13.5px ${BODY}`, color: t.muted, cursor: "pointer", background: "none", border: "none", padding: 0 },

    jobDetailWrap: { display: "grid", gridTemplateColumns: "1fr 300px", gap: 40, padding: "24px 48px 64px", alignItems: "start" },
    jobDetailMain: { display: "flex", flexDirection: "column", gap: 16 },
    jobDetailKicker: { font: `600 11px ${MONO}`, color: t.accent, textTransform: "uppercase", letterSpacing: ".05em" },
    jobDetailTitle: { font: `900 34px/1.25 ${DISPLAY}`, color: t.ink, margin: 0, letterSpacing: "-0.015em" },
    jobDetailDesc: { font: `400 15px/1.65 ${BODY}`, color: t.muted, margin: 0 },
    jobDetailCritLabel: { font: `700 12px ${MONO}`, color: t.muted, textTransform: "uppercase", letterSpacing: ".05em", marginTop: 8 },
    jobDetailCritList: { margin: 0, padding: "0 0 0 18px", display: "flex", flexDirection: "column", gap: 7 },
    jobDetailCritItem: { font: `400 14px/1.5 ${BODY}`, color: t.ink },
    jobDetailSide: { position: "sticky", top: 24 },
    jobDetailCard: { background: t.cardBg, border: `1px solid ${t.border}`, borderRadius: 16, padding: 22, display: "flex", flexDirection: "column", gap: 14 },
    metaRowD: { display: "flex", gap: 10 },
    metaBoxD: { flex: 1, background: t.bg, border: `1px solid ${t.border}`, borderRadius: 10, padding: "11px 13px", display: "flex", flexDirection: "column", gap: 3 },
    metaLabelD: { font: `600 10px ${MONO}`, color: t.muted, textTransform: "uppercase", letterSpacing: ".05em" },
    metaValD: { font: `700 16px ${MONO}`, color: t.ink },
    jobDetailClaimBtn: { display: "block", textAlign: "center", background: t.accent, color: "#fff", border: "none", borderRadius: 12, padding: 15, font: `700 15px ${BODY}`, cursor: "pointer", width: "100%" },
    jobDetailFoot: { textAlign: "center", font: `400 11.5px ${BODY}`, color: t.muted },

    signinWrap: { display: "flex", alignItems: "center", justifyContent: "center", padding: "80px 48px" },
    signinCard: { width: 420, display: "flex", flexDirection: "column", alignItems: "stretch", gap: 12 },
    signinKicker: { font: `700 11px ${MONO}`, color: t.accent, textTransform: "uppercase", letterSpacing: ".06em", textAlign: "center" },
    signinTitle: { font: `800 24px/1.35 ${DISPLAY}`, color: t.ink, textAlign: "center", margin: "0 0 4px" },
    signinSub: { font: `400 14px/1.55 ${BODY}`, color: t.muted, textAlign: "center", margin: "0 0 18px" },
    signinBtn: { display: "flex", alignItems: "center", justifyContent: "center", gap: 10, background: t.ink, color: t.bg, borderRadius: 12, padding: 14, font: `600 14px ${BODY}`, border: "none", cursor: "pointer" },
    signinBtnAlt: { display: "flex", alignItems: "center", justifyContent: "center", gap: 8, background: "transparent", color: t.ink, border: `1px solid ${t.border}`, borderRadius: 12, padding: 14, font: `600 14px ${BODY}`, cursor: "pointer" },
    signinFoot: { marginTop: 14, font: `400 12px/1.6 ${BODY}`, color: t.muted, textAlign: "center" },
    signinInput: { border: `1px solid ${t.border}`, borderRadius: 12, padding: "13px 14px", font: `400 14px ${BODY}`, color: t.ink, background: t.cardBg, outline: "none" },

    dchatPage: { minHeight: "100vh", background: t.bg, fontFamily: BODY },
    dchatWrap: { position: "relative", display: "grid", gridTemplateColumns: "300px 1fr", height: "100vh", overflow: "hidden" },
    dchatSidebar: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden", borderRight: `1px solid ${t.border}`, background: t.cardBg },
    dchatSidebarTop: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 16px 14px" },
    dchatIconRow: { display: "flex", gap: 6 },
    dchatIconBtn: { width: 30, height: 30, borderRadius: 8, border: `1px solid ${t.border}`, background: t.bg, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },
    dchatSearchWrap: { margin: "0 16px 12px", position: "relative", display: "flex", alignItems: "center" },
    dchatSearchIcon: { position: "absolute", left: 11 },
    dchatSearchInput: { width: "100%", boxSizing: "border-box", border: "none", borderRadius: 10, padding: "9px 12px 9px 32px", font: `400 13px ${BODY}`, color: t.ink, background: t.bg, outline: "none" },
    dchatTabsRow: { display: "flex", gap: 6, padding: "0 16px 12px" },
    dchatTabActive: { font: `700 12.5px ${BODY}`, color: t.ink, background: t.bg, border: `1px solid ${t.border}`, borderRadius: 8, padding: "7px 11px", display: "flex", alignItems: "center", gap: 6 },
    dchatTabBadge: { background: t.accent, color: "#fff", font: `700 10px ${BODY}`, borderRadius: 999, padding: "1px 6px" },
    dchatThreadList: { flex: 1, minHeight: 0, overflowY: "auto", borderTop: `1px solid ${t.border}` },
    dchatThreadMain: { flex: 1, display: "flex", flexDirection: "column", gap: 2, minWidth: 0 },
    dchatThreadTop: { display: "flex", justifyContent: "space-between", gap: 8 },
    dchatThreadName: { font: `600 13.5px ${BODY}`, color: t.ink, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
    dchatThreadTime: { font: `400 11px ${BODY}`, color: t.muted, flex: "none" },
    dchatThreadPreview: { font: `400 12px ${BODY}`, color: t.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
    dchatSidebarFoot: { padding: "12px 16px", borderTop: `1px solid ${t.border}` },
    dchatBrowseBtn: { display: "block", width: "100%", textAlign: "center", font: `600 13px ${BODY}`, color: t.muted, padding: 10, borderRadius: 10, border: `1px solid ${t.border}`, background: "transparent", cursor: "pointer" },
    dchatAvatar: { width: 38, height: 38, borderRadius: "50%", background: t.accentSoft, color: t.accent, display: "flex", alignItems: "center", justifyContent: "center", font: `700 12px ${BODY}`, flex: "none" },

    dchatMain: { display: "flex", flexDirection: "column", height: "100%", minHeight: 0, overflow: "hidden", background: t.bg },
    dchatHead: { display: "flex", alignItems: "center", gap: 12, padding: "16px 22px", borderBottom: `1px solid ${t.border}`, flex: "none" },
    dchatHeadSub: { font: `500 11.5px ${BODY}`, color: t.muted },
    dchatViewJobLink: { marginLeft: "auto", font: `600 12.5px ${BODY}`, color: t.accent, whiteSpace: "nowrap", background: "none", border: "none", cursor: "pointer" },
    dchatScroll: { flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 24px", display: "flex", flexDirection: "column", gap: 12 },
    dchatSysMsg: { alignSelf: "center", background: t.accentSoft, color: t.ink, font: `600 12px ${BODY}`, padding: "7px 14px", borderRadius: 20 },
    dchatComposerWrap: { display: "flex", alignItems: "center", gap: 12, padding: "14px 22px", borderTop: `1px solid ${t.border}`, flex: "none" },
    dchatComposerInput: { flex: 1, border: "none", borderRadius: 20, padding: "11px 16px", font: `400 14px ${BODY}`, color: t.ink, background: t.cardBg, outline: "none" },
    dchatSendBtn: { width: 36, height: 36, flex: "none", borderRadius: "50%", background: t.accent, border: "none", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer" },
    dchatEmpty: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, color: t.muted, font: `400 14px ${BODY}` },

    setWrap: { maxWidth: 640, margin: "0 auto", padding: "48px 24px 72px", display: "flex", flexDirection: "column", gap: 20 },
    setTitle: { font: `900 30px ${DISPLAY}`, color: t.ink, margin: 0, letterSpacing: "-0.01em" },
    setCard: { background: t.cardBg, border: `1px solid ${t.border}`, borderRadius: 16, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 12 },
    setCardHead: { font: `700 11px ${MONO}`, color: t.muted, textTransform: "uppercase", letterSpacing: ".05em" },
    setIdentityRow: { display: "flex", alignItems: "center", gap: 14 },
    setAvatar: { width: 44, height: 44, borderRadius: "50%", background: t.accentSoft, color: t.accent, display: "flex", alignItems: "center", justifyContent: "center", font: `700 14px ${BODY}`, flex: "none" },
    setIdentityMeta: { display: "flex", flexDirection: "column", gap: 2 },
    setIdentityName: { font: `600 14.5px ${BODY}`, color: t.ink },
    setIdentitySub: { font: `400 12.5px ${BODY}`, color: t.muted },
    setIdentityStatsRow: { display: "flex", alignItems: "center", gap: 20, paddingTop: 14, borderTop: `1px solid ${t.border}` },
    setStatBox: { display: "flex", flexDirection: "column", gap: 5 },
    setStatBoxDivider: { width: 1, alignSelf: "stretch", background: t.border },
    setStatVal: { font: `800 20px ${MONO}`, color: t.ink },
    setStatLabel: { font: `500 11.5px ${BODY}`, color: t.muted },
    setStarsRow: { display: "flex", alignItems: "center", gap: 4 },
    setBalanceRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 },
    setBalanceMain: { display: "flex", flexDirection: "column", gap: 4 },
    setBalanceLabel: { font: `500 12.5px ${BODY}`, color: t.muted },
    setBalanceVal: { font: `800 28px ${MONO}`, color: t.ink },
    setWithdrawBtn: { background: t.accent, color: "#fff", border: "none", borderRadius: 10, padding: "12px 20px", font: `700 13.5px ${BODY}`, cursor: "pointer" },
    setPendingNote: { font: `400 12px/1.5 ${BODY}`, color: t.muted, borderTop: `1px solid ${t.border}`, paddingTop: 10 },
    setWalletRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, background: t.bg, border: `1px solid ${t.border}`, borderRadius: 10, padding: "12px 14px" },
    setWalletAddr: { font: `600 13.5px ${MONO}`, color: t.ink },
    setWalletTag: { font: `700 10px ${BODY}`, color: t.accent, background: t.accentSoft, padding: "4px 9px", borderRadius: 999, textTransform: "uppercase", letterSpacing: ".03em" },
    setWalletHint: { font: `400 12.5px/1.55 ${BODY}`, color: t.muted, margin: 0 },
    setOverrideBtn: { alignSelf: "flex-start", background: "transparent", color: t.accent, border: `1px solid ${t.border}`, borderRadius: 9, padding: "9px 14px", font: `600 12.5px ${BODY}`, cursor: "pointer" },
    setOverrideInput: { border: `1px solid ${t.border}`, borderRadius: 9, padding: "11px 13px", font: `400 13px ${MONO}`, color: t.ink, background: t.bg, outline: "none" },
    setHistoryRow: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0", borderTop: `1px solid ${t.border}` },
    setHistoryMain: { display: "flex", flexDirection: "column", gap: 2 },
    setHistoryTitle: { font: `500 13px ${BODY}`, color: t.ink },
    setHistoryDate: { font: `400 11.5px ${BODY}`, color: t.muted },
  };
}

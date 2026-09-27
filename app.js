import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// Backend Supabase (publishable key: safe to expose in a browser app; RLS protects user data).
const SUPABASE_URL = "https://lttnxzjqzkufkwbqwmko.supabase.co";
const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_HKZWxGwqNoHTj-6PD_Hj4g__CKo60Hs";
const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

const $ = id => document.getElementById(id);
const $all = sel => document.querySelectorAll(sel);
const fmt = n => new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(n || 0);
const syncPresentedUI = () => {
  const anyModalOpen = !!document.querySelector(".modal-backdrop.show");
  document.body.classList.toggle("modal-open", anyModalOpen);
  document.documentElement.style.overflow = anyModalOpen ? "hidden" : "";
};

const resetSheetPosition = backdrop => {
  const sheet = backdrop?.querySelector(".sheet");
  if (!sheet) return;
  sheet.classList.remove("is-dragging");
  sheet.style.transform = "";
  sheet.style.opacity = "";
};

const modal = (id, show) => {
  const el = $(id);
  if (!el) return;

  if (show) {
    // iOS presents one foreground sheet at a time.
    $all(".modal-backdrop.show").forEach(open => {
      if (open !== el) {
        open.classList.remove("show");
        resetSheetPosition(open);
      }
    });
    resetSheetPosition(el);
    el.classList.add("show");
  } else {
    el.classList.remove("show");
    resetSheetPosition(el);
  }

  syncPresentedUI();
};

const notify = (msg, icon = "info") => {
  const sb = $("snackbar");
  if (!sb) return;
  $("sbMsg").textContent = msg;
  $("sbIcon").textContent = icon;
  sb.classList.add("show");
  clearTimeout(window._sb);
  window._sb = setTimeout(() => sb.classList.remove("show"), 2800);
};

const CATS = {
  expense: [
    { id: "vtc_taxi", label: "VTC & Taxi", icon: "local_taxi" }, { id: "credit", label: "Crédit", icon: "account_balance" },
    { id: "assurance", label: "Assurance", icon: "shield" }, { id: "abonnement", label: "Abonnement", icon: "subscriptions" },
    { id: "transport_commun", label: "Transport en commun", icon: "directions_subway" }, { id: "vehicule", label: "Véhicule", icon: "directions_car" },
    { id: "supermarche", label: "Supermarché", icon: "shopping_cart" }, { id: "shopping", label: "Shopping", icon: "shopping_bag" },
    { id: "restaurant", label: "Restaurant", icon: "restaurant" }, { id: "boulangerie", label: "Boulangerie", icon: "bakery_dining" },
    { id: "sante", label: "Santé", icon: "medical_services" }, { id: "hygiene_corporelle", label: "Hygiène corporelle", icon: "soap" },
    { id: "soins_beaute", label: "Soins & beauté", icon: "spa" }, { id: "entretien_maison", label: "Entretien maison", icon: "cleaning_services" },
    { id: "logement", label: "Logement", icon: "home" }, { id: "energie", label: "Eau, gaz & électricité", icon: "bolt" },
    { id: "loisir", label: "Loisirs & Sorties", icon: "sports_esports" }
  ],
  income: [
    { id: "salaire", label: "Salaire & Prime", icon: "payments" },
    { id: "caf", label: "CAF", icon: "family_restroom" },
    { id: "chomage", label: "Chômage", icon: "work_off" },
    { id: "aah", label: "AAH", icon: "accessible" },
    { id: "rsa", label: "RSA", icon: "handshake" },
    { id: "remboursement", label: "Remboursement", icon: "currency_exchange" },
    { id: "indemnites_maladie", label: "Indemnités maladie", icon: "health_and_safety" }
  ]
};
const ALL_CATS = [...CATS.expense, ...CATS.income];
const normalizeSearchText = value => String(value || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLocaleLowerCase("fr-FR")
  .trim();

let currentUser = null, currentHouseholdId = null, realtimeChannel = null, transactions = [];
let budgets = {}; // { [categoryId]: montant mensuel }
let currentFilter = "all", editingId = null, selectedId = null, modalType = "expense", searchQuery = "";
let currentMonth = new Date().toISOString().slice(0, 7);
let comparedMonth = currentMonth;
let referenceMonth = (() => {
  const [year, month] = currentMonth.split("-").map(Number);
  const previous = new Date(year, month - 2, 1);
  return `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, "0")}`;
})();
let monthPickerMode = "navigate"; // navigate | reschedule | comparison-primary | comparison-reference
let rescheduleTxId = null;
let longPressTimer = null;
let longPressStart = null;
let longPressConsumedId = null;
const dateGroupCollapsedState = new Map();
const weekGroupCollapsedState = new Map();

const getCurrentMonthTransactions = () => transactions.filter(t => (t.date || "").startsWith(currentMonth));
const sum = (arr, fn) => arr.filter(fn).reduce((s, t) => s + (Number(t.amount) || 0), 0);

const hasBudget = categoryId => Object.prototype.hasOwnProperty.call(budgets, categoryId);

function getBudgetTracking(mTx = getCurrentMonthTransactions()) {
  const spentByCategory = {};
  mTx.forEach(t => {
    if (t.type !== "expense" || t.isReimbursed) return;
    const categoryId = t.category || "divers";
    spentByCategory[categoryId] = (spentByCategory[categoryId] || 0) + (Number(t.amount) || 0);
  });

  const rows = CATS.expense.map(cat => {
    const defined = hasBudget(cat.id);
    const budget = defined ? Math.max(0, Number(budgets[cat.id]) || 0) : null;
    const spent = spentByCategory[cat.id] || 0;
    const over = defined ? Math.max(0, spent - budget) : 0;
    const remaining = defined ? Math.max(0, budget - spent) : null;
    return { ...cat, defined, budget, spent, over, remaining };
  });

  const definedRows = rows.filter(row => row.defined);
  return {
    rows,
    definedCount: definedRows.length,
    overCount: definedRows.filter(row => row.over > 0).length,
    totalOver: definedRows.reduce((total, row) => total + row.over, 0),
    totalBudgeted: definedRows.reduce((total, row) => total + row.budget, 0)
  };
}

// By default, only today stays expanded.
// Every other date group starts collapsed; a manual choice is kept in dateGroupCollapsedState.
const shouldCollapseDateGroupByDefault = date => {
  const [y, m, d] = String(date || "").split("-").map(Number);
  if (![y, m, d].every(Number.isFinite)) return true;
  const dateObj = new Date(y, m - 1, d);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  dateObj.setHours(0, 0, 0, 0);
  const diff = Math.round((today - dateObj) / 86400000);
  return diff !== 0;
};


const parseTxDate = date => {
  const [y, m, d] = String(date || "").split("-").map(Number);
  if (![y, m, d].every(Number.isFinite)) return null;
  const result = new Date(y, m - 1, d);
  result.setHours(0, 0, 0, 0);
  return result;
};

const toLocalDateKey = date => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
};

const getWeekBounds = date => {
  const day = date.getDay() || 7; // lundi = 1, dimanche = 7
  const start = new Date(date);
  start.setDate(start.getDate() - (day - 1));
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  end.setHours(0, 0, 0, 0);
  return { start, end };
};

const isCompletedWeek = dateString => {
  const date = parseTxDate(dateString);
  if (!date) return false;
  const { end } = getWeekBounds(date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return end < today;
};

const getWeekKey = dateString => {
  const date = parseTxDate(dateString);
  if (!date) return `week-${dateString}`;
  return toLocalDateKey(getWeekBounds(date).start);
};

const formatWeekLabel = weekStart => {
  const { start, end } = getWeekBounds(weekStart);
  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  if (sameMonth) return `Semaine du ${start.getDate()} au ${end.getDate()}`;
  const monthFmt = new Intl.DateTimeFormat("fr-FR", { month: "short" });
  return `Semaine du ${start.getDate()} ${monthFmt.format(start)} au ${end.getDate()} ${monthFmt.format(end)}`;
};

const getIsoWeekNumber = date => {
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  target.setUTCDate(target.getUTCDate() + 4 - (target.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  return Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
};

function drawDonut(canvasId, totalBadgeId, totalTextId, breakdownId, items, palette, emptyMsg) {
  const data = {};
  const total = items.reduce((acc, t) => {
    const amt = parseFloat(t.amount) || 0;
    data[t.category] = (data[t.category] || 0) + amt;
    return acc + amt;
  }, 0);

  if ($(totalBadgeId)) $(totalBadgeId).textContent = fmt(total);
  if ($(totalTextId)) $(totalTextId).textContent = fmt(total);

  const bd = $(breakdownId);
  if (bd) bd.innerHTML = "";

  const canvas = $(canvasId);
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = canvas.height = 220 * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, 220, 220);

  if (!total || !Object.keys(data).length) {
    ctx.beginPath();
    ctx.arc(110, 110, 84, 0, 2 * Math.PI);
    ctx.strokeStyle = "#111111";
    ctx.lineWidth = 28;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(110, 110, 84, 0, 2 * Math.PI);
    ctx.strokeStyle = "#FFF7D6";
    ctx.lineWidth = 20;
    ctx.stroke();

    if (bd) {
      bd.innerHTML = `<div style="text-align:center; padding:16px 8px; color:var(--md-sys-color-outline); font-size:12px;">${emptyMsg}</div>`;
    }
    return;
  }

  const keys = Object.keys(data).sort((a, b) => data[b] - data[a]);
  const segs = keys.map((k, i) => ({ id: k, amt: data[k], color: palette[i % palette.length] }));

  // Neo-brutal donut: black structural ring underneath the colored data.
  ctx.beginPath();
  ctx.arc(110, 110, 84, 0, 2 * Math.PI);
  ctx.strokeStyle = "#111111";
  ctx.lineWidth = 30;
  ctx.stroke();

  let angle = -0.5 * Math.PI;
  segs.forEach(seg => {
    const slice = (seg.amt / total) * (2 * Math.PI);
    const gap = segs.length > 1 ? Math.min(0.055, slice * 0.16) : 0;
    const startAngle = angle + gap / 2;
    const endAngle = angle + slice - gap / 2;

    ctx.beginPath();
    ctx.arc(110, 110, 84, startAngle, endAngle);
    ctx.strokeStyle = seg.color;
    ctx.lineWidth = 20;
    ctx.lineCap = "butt";
    ctx.stroke();

    angle += slice;

    if (bd) {
      const cat = ALL_CATS.find(c => c.id === seg.id) || { label: seg.id || "Autres", icon: "more_horiz" };
      const percent = Math.round((seg.amt / total) * 100);
      bd.insertAdjacentHTML("beforeend", `
        <div class="breakdown-row">
          <div style="display:flex; align-items:center; gap:8px; min-width:0;">
            <div style="background:${seg.color}; width:32px; height:32px; border:2px solid #111; border-radius:7px; display:grid; place-content:center; color:#111; flex-shrink:0; box-shadow:3px 3px 0 #111;">
              <span class="material-symbols-rounded" style="font-size:16px;">${cat.icon}</span>
            </div>
            <span style="font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${cat.label}</span>
          </div>
          <div style="display:flex; align-items:center; gap:6px; flex-shrink:0;">
            <strong>${fmt(seg.amt)}</strong>
            <span class="ios-badge" style="padding:2px 6px; font-size:10px;">${percent}%</span>
          </div>
        </div>`);
    }
  });
}

function renderApp() {
  const mTx = getCurrentMonthTransactions();
  const inc = sum(mTx, t => t.type === "income");
  const exp = sum(mTx, t => t.type === "expense" && !t.isReimbursed);
  const fix = sum(mTx, t => (t.isFixed === true || t.isFixed === "true" || t.isFixed === 1) && t.type === "expense" && !t.isReimbursed);

  if ($("kpiNet")) $("kpiNet").textContent = fmt(inc - exp);
  if ($("kpiIncome")) $("kpiIncome").textContent = `+${fmt(inc)}`;
  if ($("kpiExpense")) $("kpiExpense").textContent = `-${fmt(exp)}`;
  if ($("kpiFixed")) $("kpiFixed").textContent = fmt(fix);

  // Reste à vivre prévu = revenus du mois - somme des enveloppes budgétaires définies.
  // Un budget explicite à 0 € reste un budget défini.
  const kpiForecastEl = $("kpiForecast");
  if (kpiForecastEl) {
    const budgetTracking = getBudgetTracking(mTx);
    if (budgetTracking.definedCount) {
      kpiForecastEl.textContent = `Prévu ${fmt(inc - budgetTracking.totalBudgeted)}`;
    } else {
      kpiForecastEl.textContent = "";
    }
  }

  let list = mTx.filter(t => {
    const isFix = (t.isFixed === true || t.isFixed === "true" || t.isFixed === 1);
    if (currentFilter === "income") return t.type === "income";
    if (currentFilter === "expense") return t.type === "expense" && !isFix;
    if (currentFilter === "fixed") return isFix;
    return true;
  });

  if (searchQuery.trim()) {
    const q = normalizeSearchText(searchQuery);
    const amountQuery = searchQuery.trim().replace(',', '.');

    list = list.filter(t => {
      const [y, m, d] = (t.date || "").split("-");
      const category = ALL_CATS.find(cat => cat.id === t.category);
      const searchableCategory = normalizeSearchText(`${t.category || ""} ${category?.label || ""}`);

      return (Number(t.amount) || 0).toFixed(2).includes(amountQuery)
        || normalizeSearchText(t.label).includes(q)
        || searchableCategory.includes(q)
        || `${d}/${m}`.includes(q)
        || `${d}/${m}/${y}`.includes(q);
    });
  }

  if ($("secBadge")) $("secBadge").textContent = `${list.length} op.`;
  list.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

  const txCont = $("txContainer");
  if (txCont) {
    if (!list.length) {
      txCont.innerHTML = `
        <div style="text-align:center; padding:36px 16px; color:var(--md-sys-color-outline);">
          <span class="material-symbols-rounded" style="font-size:42px; opacity:.4;">search_off</span>
          <p style="margin-top:6px; font-weight:700;">Aucune opération trouvée</p>
        </div>`;
    } else {
      const groups = [];
      list.forEach(tx => {
        let group = groups[groups.length - 1];
        if (!group || group.date !== tx.date) {
          group = { date: tx.date, items: [] };
          groups.push(group);
        }
        group.items.push(tx);
      });

      const renderDateGroup = group => {
        const [y, m, d] = (group.date || "").split("-").map(Number);
        const dateObj = new Date(y, m - 1, d);
        const today = new Date();
        today.setHours(0,0,0,0);
        dateObj.setHours(0,0,0,0);
        const diff = Math.round((today - dateObj) / 86400000);
        const dateLabel = diff === 0 ? "Aujourd'hui" : diff === 1 ? "Hier" : diff === 2 ? "Avant-hier" : dateObj.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });

        // During a search, matching transactions stay visible. Outside search,
        // manual state wins; otherwise every date except today starts collapsed.
        const defaultCollapsed = shouldCollapseDateGroupByDefault(group.date);
        const collapsed = !searchQuery.trim() && (
          dateGroupCollapsedState.has(group.date)
            ? dateGroupCollapsedState.get(group.date)
            : defaultCollapsed
        );
        const expenseTotal = group.items
          .filter(tx => tx.type === "expense" && !tx.isReimbursed)
          .reduce((total, tx) => total + (Number(tx.amount) || 0), 0);
        const incomeTotal = group.items
          .filter(tx => tx.type === "income")
          .reduce((total, tx) => total + (Number(tx.amount) || 0), 0);
        const netTotal = incomeTotal - expenseTotal;
        const reimbursedCount = group.items.filter(tx => tx.type === "expense" && tx.isReimbursed).length;
        const operationLabel = `${group.items.length} opération${group.items.length > 1 ? "s" : ""}`;
        const reimbursedLabel = reimbursedCount ? ` · ${reimbursedCount} remboursée${reimbursedCount > 1 ? "s" : ""}` : "";

        let dayHtml = `
          <section class="date-group ${collapsed ? 'is-collapsed' : ''}" data-date="${group.date}">
            <button class="date-group-heading" type="button" data-date="${group.date}" aria-expanded="${collapsed ? 'false' : 'true'}" aria-label="${collapsed ? 'Déplier' : 'Replier'} les opérations du ${dateLabel}">
              <span class="date-group-header">${dateLabel}</span>
              <span class="date-group-chevron" aria-hidden="true">
                <span class="material-symbols-rounded">${collapsed ? 'expand_more' : 'expand_less'}</span>
              </span>
            </button>`;

        if (collapsed) {
          dayHtml += `
            <div class="date-group-summary">
              <div class="date-group-summary-copy">
                <strong>${operationLabel}</strong>
                <span>Dépenses ${fmt(expenseTotal)} · Revenus ${fmt(incomeTotal)}${reimbursedLabel}</span>
              </div>
              <div class="date-group-summary-net ${netTotal > 0 ? 'positive' : netTotal < 0 ? 'negative' : ''}">
                <small>Solde</small>
                <strong>${netTotal > 0 ? '+' : ''}${fmt(netTotal)}</strong>
              </div>
            </div>`;
        } else {
          dayHtml += `<div class="date-group-items">`;
          group.items.forEach(tx => {
            const cat = ALL_CATS.find(x => x.id === tx.category) || { label: tx.category || "Divers", icon: "category" };
            const isExp = tx.type === "expense";
            const isFix = (tx.isFixed === true || tx.isFixed === "true" || tx.isFixed === 1);
            const isReimb = !!tx.isReimbursed;

            dayHtml += `
              <div class="tx-item ios-press" data-id="${tx.id}">
                <div class="tx-left">
                  <div class="tx-icon-wrap"><span class="material-symbols-rounded">${cat.icon}</span></div>
                  <div style="min-width:0;">
                    <div class="tx-title">${tx.label}</div>
                    <div class="tx-meta">
                      <span>${cat.label}</span>
                      ${isFix ? `<span class="tag-pill tag-fixed">Charge</span>` : ""}
                      ${isReimb ? `<span class="tag-pill tag-reimbursed">Remboursé</span>` : ""}
                    </div>
                  </div>
                </div>
                <div class="tx-amount ${isExp ? '' : 'income'} ${isReimb ? 'reimbursed' : ''}">${isExp ? '-' : '+'}${fmt(tx.amount)}</div>
              </div>`;
          });
          dayHtml += `</div>`;
        }

        dayHtml += `</section>`;
        return dayHtml;
      };

      // A completed week becomes one compact weekly group. The current week
      // remains day-by-day. Expanding a week reveals the same collapsible days.
      const blocks = [];
      groups.forEach(group => {
        if (!isCompletedWeek(group.date)) {
          blocks.push({ type: "day", group });
          return;
        }

        const weekKey = getWeekKey(group.date);
        let week = blocks[blocks.length - 1];
        if (!week || week.type !== "week" || week.key !== weekKey) {
          const date = parseTxDate(group.date);
          const { start, end } = getWeekBounds(date);
          week = { type: "week", key: weekKey, start, end, days: [] };
          blocks.push(week);
        }
        week.days.push(group);
      });

      let html = "";
      blocks.forEach(block => {
        if (block.type === "day") {
          html += renderDateGroup(block.group);
          return;
        }

        const weekCollapsed = !searchQuery.trim() && (
          weekGroupCollapsedState.has(block.key)
            ? weekGroupCollapsedState.get(block.key)
            : true
        );
        const weekLabel = formatWeekLabel(block.start);
        const weekNumber = getIsoWeekNumber(block.start);

        html += `
          <section class="week-group ${weekCollapsed ? 'is-collapsed' : ''}" data-week="${block.key}">
            <button class="week-group-heading" type="button" data-week="${block.key}" aria-expanded="${weekCollapsed ? 'false' : 'true'}" aria-label="${weekCollapsed ? 'Déplier' : 'Replier'} ${weekLabel}, semaine ${weekNumber}">
              <span class="date-group-header">${weekLabel}</span>
              <span class="week-group-meta" aria-hidden="true">
                ${weekCollapsed ? `<span class="week-group-number">S${weekNumber}</span>` : ""}
                <span class="date-group-chevron">
                  <span class="material-symbols-rounded">${weekCollapsed ? 'expand_more' : 'expand_less'}</span>
                </span>
              </span>
            </button>`;

        if (!weekCollapsed) {
          html += `<div class="week-group-days">`;
          block.days.forEach(group => { html += renderDateGroup(group); });
          html += `</div>`;
        }

        html += `</section>`;
      });
      txCont.innerHTML = html;
    }
  }

  renderAnalytics(mTx, inc);
}

function fitTextToWidth(el, { max = 12, min = 9, step = 0.25 } = {}) {
  if (!el) return;
  el.style.fontSize = `${max}px`;
  let size = max;
  while (size > min && el.scrollWidth > el.clientWidth + 1) {
    size = Math.max(min, size - step);
    el.style.fontSize = `${size}px`;
  }
}

function autoSizeBudgetInput(inp) {
  if (!inp) return;
  const value = inp.value || inp.placeholder || '—';
  const mirror = document.createElement('span');
  const styles = getComputedStyle(inp);
  mirror.textContent = value;
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre';
  mirror.style.font = styles.font;
  mirror.style.fontSize = styles.fontSize;
  mirror.style.fontWeight = styles.fontWeight;
  mirror.style.letterSpacing = styles.letterSpacing;
  mirror.style.padding = '0';
  mirror.style.border = '0';
  document.body.appendChild(mirror);
  const horizontalPadding = parseFloat(styles.paddingLeft || '0') + parseFloat(styles.paddingRight || '0');
  const borderWidth = (parseFloat(styles.borderLeftWidth || '0') + parseFloat(styles.borderRightWidth || '0')) || 0;
  const minWidth = 74;
  const maxWidth = Math.min(180, window.innerWidth * 0.42);
  const targetWidth = Math.max(minWidth, Math.min(maxWidth, Math.ceil(mirror.getBoundingClientRect().width + horizontalPadding + borderWidth + 2)));
  inp.style.width = `${targetWidth}px`;
  document.body.removeChild(mirror);
}

function refreshBudgetRowSizing(scope = document) {
  scope.querySelectorAll('.budget-input').forEach(autoSizeBudgetInput);
  scope.querySelectorAll('.budget-status').forEach(el => fitTextToWidth(el, { max: 10, min: 8.5, step: 0.25 }));
}

const formatBudgetCollapseSummary = tracking => {
  if (!tracking.definedCount) return "Aucun budget défini";
  const count = `${tracking.definedCount} budget${tracking.definedCount > 1 ? "s" : ""}`;
  const status = tracking.totalOver > 0
    ? `+${fmt(tracking.totalOver)} hors budget`
    : "aucun dépassement";
  return `${count} · ${fmt(tracking.totalBudgeted)} au total · ${status}`;
};

function setSettingsSectionExpanded(toggleId, contentId, label, expanded) {
  const toggle = $(toggleId);
  const content = $(contentId);
  if (!toggle || !content) return;

  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.setAttribute("aria-label", `${expanded ? "Replier" : "Déplier"} ${label}`);
  content.hidden = !expanded;
  const icon = toggle.querySelector(".material-symbols-rounded");
  if (icon) icon.textContent = expanded ? "expand_less" : "expand_more";
  if (expanded) requestAnimationFrame(() => refreshBudgetRowSizing(content));
}

function bindCollapsibleSettingsSection(toggleId, contentId, label) {
  const toggle = $(toggleId);
  if (!toggle) return;

  const setExpanded = expanded => setSettingsSectionExpanded(toggleId, contentId, label, expanded);
  setExpanded(false);
  toggle.onclick = () => setExpanded(toggle.getAttribute("aria-expanded") !== "true");
}

function renderBudgetsSettings() {
  const cont = $("budgetsList");
  const summary = $("budgetOverSummary");
  if (!cont) return;

  const tracking = getBudgetTracking();
  const collapseSummary = $("budgetCollapseSummary");
  if (collapseSummary) collapseSummary.textContent = formatBudgetCollapseSummary(tracking);

  if (summary) {
    if (!tracking.definedCount) {
      summary.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 10px;border:1px solid var(--ios-separator);border-radius:12px;">
        <span style="font-size:12px;font-weight:700;">Hors budget total</span>
        <strong style="font-size:13px;color:var(--md-sys-color-outline);">—</strong>
      </div>`;
    } else {
      const over = tracking.totalOver > 0;
      summary.innerHTML = `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 10px;border:1px solid ${over ? 'var(--md-sys-color-error)' : 'var(--ios-separator)'};border-radius:12px;">
        <span style="font-size:12px;font-weight:700;">Hors budget total${tracking.overCount ? ` · ${tracking.overCount} catégorie${tracking.overCount > 1 ? 's' : ''}` : ''}</span>
        <strong style="font-size:13px;color:${over ? 'var(--md-sys-color-error)' : 'var(--md-sys-color-success)'};">${over ? '+' : ''}${fmt(tracking.totalOver)}</strong>
      </div>`;
    }
  }

  cont.innerHTML = tracking.rows.map(cat => {
    const display = cat.defined
      ? cat.budget.toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "";

    let status = "Aucun budget défini";
    let statusColor = "var(--md-sys-color-outline)";
    if (cat.defined && cat.over > 0) {
      status = `Dépensé ${fmt(cat.spent)} · +${fmt(cat.over)} hors budget`;
      statusColor = "var(--md-sys-color-error)";
    } else if (cat.defined) {
      status = `Dépensé ${fmt(cat.spent)} · Reste ${fmt(cat.remaining)}`;
      statusColor = "var(--md-sys-color-success)";
    }

    return `
      <div class="budget-row">
        <div class="budget-row-left">
          <span class="material-symbols-rounded">${cat.icon}</span>
          <div style="min-width:0;">
            <div class="budget-label">${cat.label}</div>
            <div class="budget-status" style="color:${statusColor};">${status}</div>
          </div>
        </div>
        <input type="tel" inputmode="numeric" class="ios-input budget-input" data-cat="${cat.id}" placeholder="—" value="${display}" />
      </div>`;
  }).join("");

  cont.querySelectorAll(".budget-input").forEach(inp => {
    inp.oninput = () => {
      const d = inp.value.replace(/\D/g, "");
      inp.value = d ? (parseInt(d, 10) / 100).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "";
      autoSizeBudgetInput(inp);
    };
    inp.onblur = () => {
      const raw = inp.value.trim();
      if (!raw) {
        saveBudget(inp.dataset.cat, null);
        return;
      }
      const amount = parseFloat(raw.replace(/\s/g, "").replace(",", "."));
      saveBudget(inp.dataset.cat, Number.isFinite(amount) ? Math.max(0, amount) : 0);
    };
    autoSizeBudgetInput(inp);
  });

  refreshBudgetRowSizing(cont);
}

async function saveBudget(categoryId, amount) {
  if (!currentUser || !currentHouseholdId) return notify("Connectez-vous pour définir un budget", "error");

  const hadPrevious = hasBudget(categoryId);
  const previous = budgets[categoryId];
  const removing = amount === null;

  if (removing) delete budgets[categoryId];
  else budgets[categoryId] = Math.max(0, Number(amount) || 0);

  renderBudgetsSettings();
  renderApp();

  let error;
  if (removing) {
    ({ error } = await supabase
      .from("household_budgets")
      .delete()
      .eq("household_id", currentHouseholdId)
      .eq("category", categoryId));
  } else {
    ({ error } = await supabase
      .from("household_budgets")
      .upsert(
        { household_id: currentHouseholdId, category: categoryId, monthly_amount: budgets[categoryId] },
        { onConflict: "household_id,category" }
      ));
  }

  if (error) {
    if (hadPrevious) budgets[categoryId] = previous;
    else delete budgets[categoryId];
    renderBudgetsSettings();
    renderApp();
    notify("Erreur lors de l'enregistrement du budget", "error");
    return;
  }

  notify(removing ? "Budget supprimé" : "Budget enregistré", removing ? "delete" : "check_circle");
}

async function loadBudgets() {
  if (!currentUser || !currentHouseholdId) {
    budgets = {};
    renderBudgetsSettings();
    renderApp();
    return;
  }
  const { data, error } = await supabase
    .from("household_budgets")
    .select("category, monthly_amount")
    .eq("household_id", currentHouseholdId);
  if (error) throw error;
  budgets = {};
  (data || []).forEach(row => {
    const amount = Number(row.monthly_amount);
    budgets[row.category] = Number.isFinite(amount) ? Math.max(0, amount) : 0;
  });
  renderBudgetsSettings();
  renderApp();
}

const formatComparisonMonth = (monthKey, format = "long") => {
  const [year, month] = String(monthKey || "").split("-").map(Number);
  if (!Number.isFinite(year) || !Number.isFinite(month)) return "Mois inconnu";
  const options = { month: format === "long" ? "long" : "short" };
  if (format !== "compact") options.year = "numeric";
  return new Intl.DateTimeFormat("fr-FR", options).format(new Date(year, month - 1, 1));
};

const getMonthlySnapshot = (source, monthKey) => {
  const items = source.filter(t => String(t.date || "").slice(0, 7) === monthKey);
  const incomes = items
    .filter(t => t.type === "income")
    .reduce((total, t) => total + (Number(t.amount) || 0), 0);
  const expenseItems = items.filter(t => t.type === "expense" && !t.isReimbursed);
  const expenses = expenseItems.reduce((total, t) => total + (Number(t.amount) || 0), 0);
  const categories = expenseItems.reduce((totals, t) => {
    const categoryId = t.category || "divers";
    totals[categoryId] = (totals[categoryId] || 0) + (Number(t.amount) || 0);
    return totals;
  }, {});
  return { monthKey, items, incomes, expenses, balance: incomes - expenses, categories };
};

const getComparisonDelta = (current, reference) => {
  const amount = current - reference;
  const percent = reference === 0
    ? (current === 0 ? 0 : null)
    : (amount / Math.abs(reference)) * 100;
  return { amount, percent };
};

const getExpenseChangeTone = delta => {
  if (Math.abs(delta.amount) < 0.005) return "neutral";
  if (delta.amount < 0) return "good";
  // Jusqu'à 10 % la hausse reste légère ; au-delà elle est signalée comme forte.
  if (delta.percent !== null && delta.percent <= 10) return "warning";
  return "bad";
};

const getImprovementTone = delta => {
  if (Math.abs(delta.amount) < 0.005) return "neutral";
  return delta.amount > 0 ? "good" : "bad";
};

const formatSignedCurrency = value => `${value > 0 ? "+" : ""}${fmt(value)}`;
const formatComparisonPercent = percent => {
  if (percent === null) return "% non calculable";
  const formatted = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1 }).format(Math.abs(percent));
  return `${percent > 0 ? "+" : percent < 0 ? "−" : ""}${formatted} %`;
};
const formatComparisonDelta = delta => `${formatSignedCurrency(delta.amount)} · ${formatComparisonPercent(delta.percent)}`;
const escapeComparisonHtml = value => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#039;");

function renderMonthlyComparison() {
  const compared = getMonthlySnapshot(transactions, comparedMonth);
  const reference = getMonthlySnapshot(transactions, referenceMonth);
  const comparedLabel = formatComparisonMonth(comparedMonth);
  const referenceLabel = formatComparisonMonth(referenceMonth);
  const comparedShort = formatComparisonMonth(comparedMonth, "short");
  const referenceShort = formatComparisonMonth(referenceMonth, "short");
  const comparedCompact = formatComparisonMonth(comparedMonth, "compact");
  const referenceCompact = formatComparisonMonth(referenceMonth, "compact");

  if ($("comparisonMonthPrimaryLabel")) $("comparisonMonthPrimaryLabel").textContent = comparedLabel;
  if ($("comparisonMonthReferenceLabel")) $("comparisonMonthReferenceLabel").textContent = referenceLabel;
  if ($("comparisonMonthPrimaryButton")) $("comparisonMonthPrimaryButton").setAttribute("aria-label", `Choisir le mois comparé, ${comparedLabel}`);
  if ($("comparisonMonthReferenceButton")) $("comparisonMonthReferenceButton").setAttribute("aria-label", `Choisir le mois de référence, ${referenceLabel}`);
  $all(".comparison-primary-short").forEach(el => { el.textContent = comparedCompact; });
  $all(".comparison-reference-short").forEach(el => { el.textContent = referenceCompact; });

  const emptyMessages = $("comparisonEmptyMessages");
  if (emptyMessages) {
    const messages = [];
    if (!compared.items.length) messages.push(`Aucune transaction en ${comparedLabel}.`);
    if (!reference.items.length) messages.push(`Aucune transaction en ${referenceLabel}.`);
    emptyMessages.innerHTML = messages.map(message => `
      <div class="comparison-empty-note">
        <span class="material-symbols-rounded" aria-hidden="true">info</span>
        <span>${escapeComparisonHtml(message)}</span>
      </div>`).join("");
  }

  const setMetric = (name, current, previous, tone) => {
    if ($(`comparison${name}Primary`)) $(`comparison${name}Primary`).textContent = fmt(current);
    if ($(`comparison${name}Reference`)) $(`comparison${name}Reference`).textContent = fmt(previous);
    const delta = getComparisonDelta(current, previous);
    const deltaEl = $(`comparison${name}Delta`);
    if (deltaEl) {
      deltaEl.className = `comparison-delta comparison-tone-${tone(delta)}`;
      deltaEl.textContent = formatComparisonDelta(delta);
      if (delta.percent === null) deltaEl.title = "Pourcentage indisponible car la valeur de référence est nulle";
      else deltaEl.removeAttribute("title");
    }
    return delta;
  };

  setMetric("Income", compared.incomes, reference.incomes, getImprovementTone);
  const expenseDelta = setMetric("Expense", compared.expenses, reference.expenses, getExpenseChangeTone);
  setMetric("Balance", compared.balance, reference.balance, getImprovementTone);

  const expenseStatus = $("comparisonExpenseStatus");
  if (expenseStatus) {
    const tone = getExpenseChangeTone(expenseDelta);
    let icon = "drag_handle";
    let text = `Dépenses stables entre ${referenceShort} et ${comparedShort}.`;
    if (expenseDelta.amount < 0) {
      icon = "trending_down";
      text = `Amélioration : les dépenses ont diminué de ${fmt(Math.abs(expenseDelta.amount))} (${formatComparisonPercent(expenseDelta.percent).replace("−", "")}).`;
    } else if (expenseDelta.amount > 0 && tone === "warning") {
      icon = "trending_up";
      text = `Légère hausse des dépenses : ${formatComparisonDelta(expenseDelta)}.`;
    } else if (expenseDelta.amount > 0) {
      icon = "trending_up";
      text = expenseDelta.percent === null
        ? `Forte hausse des dépenses : ${formatSignedCurrency(expenseDelta.amount)} depuis une référence à 0 €.`
        : `Forte hausse des dépenses : ${formatComparisonDelta(expenseDelta)}.`;
    }
    expenseStatus.className = `comparison-expense-status comparison-tone-${tone}`;
    expenseStatus.innerHTML = `<span class="material-symbols-rounded" aria-hidden="true">${icon}</span><span>${escapeComparisonHtml(text)}</span>`;
  }

  const categoryList = $("comparisonCategoryList");
  if (!categoryList) return;
  const categoryIds = [...new Set([...Object.keys(compared.categories), ...Object.keys(reference.categories)])];
  const rows = categoryIds.map(categoryId => {
    const current = compared.categories[categoryId] || 0;
    const previous = reference.categories[categoryId] || 0;
    const delta = getComparisonDelta(current, previous);
    const category = ALL_CATS.find(cat => cat.id === categoryId) || { label: categoryId || "Divers", icon: "category" };
    return { category, current, previous, delta, tone: getExpenseChangeTone(delta) };
  }).sort((a, b) => Math.abs(b.delta.amount) - Math.abs(a.delta.amount) || b.current - a.current);

  if (!rows.length) {
    categoryList.innerHTML = `<div class="comparison-category-empty">Aucune dépense non remboursée à comparer pour ces deux mois.</div>`;
    return;
  }

  categoryList.innerHTML = rows.map(row => {
    const direction = row.delta.amount > 0 ? "Hausse" : row.delta.amount < 0 ? "Baisse" : "Stable";
    return `
      <div class="comparison-category-row">
        <div class="comparison-category-main">
          <div class="comparison-category-icon"><span class="material-symbols-rounded" aria-hidden="true">${escapeComparisonHtml(row.category.icon)}</span></div>
          <div class="comparison-category-copy">
            <strong>${escapeComparisonHtml(row.category.label)}</strong>
            <small>${escapeComparisonHtml(referenceShort)} ${fmt(row.previous)} → ${escapeComparisonHtml(comparedShort)} ${fmt(row.current)}</small>
          </div>
        </div>
        <div class="comparison-category-delta comparison-tone-${row.tone}">${direction} · ${escapeComparisonHtml(formatComparisonDelta(row.delta))}</div>
      </div>`;
  }).join("");
}

function renderAnalytics(
  monthTransactions = getCurrentMonthTransactions(),
  incomeTotal = sum(monthTransactions, t => t.type === "income")
) {
  renderMonthlyComparison();
  const obligationsTotal = sum(monthTransactions, t => t.type === "expense" && !t.isReimbursed && ((t.isFixed === true || t.isFixed === "true" || t.isFixed === 1) || t.category === "supermarche"));
  const wantsTotal = sum(monthTransactions, t => t.type === "expense" && !t.isReimbursed && !t.isFixed && t.category !== "supermarche");
  const savingsTotal = Math.max(0, incomeTotal - obligationsTotal - wantsTotal);

  const setRule = (id, current, target, isSavings = false) => {
    if (!$(id.pb) || !$(id.st) || !$(id.sp) || !$(id.ceil)) return;
    const percentage = target > 0 ? (current / target) * 100 : 0;
    const over = current > target;
    $(id.pb).style.width = `${Math.min(100, percentage)}%`;
    $(id.pb).style.background = isSavings ? "var(--md-sys-color-success)" : (over ? "var(--md-sys-color-error)" : "var(--md-sys-color-primary)");

    const stEl = $(id.st);
    if (isSavings) {
      stEl.style.color = "var(--md-sys-color-success)";
      stEl.textContent = current >= target && target > 0 ? `Atteint (+${fmt(current - target)})` : `Reste ${fmt(Math.max(0, target - current))}`;
    } else {
      stEl.style.color = over ? "var(--md-sys-color-error)" : "var(--md-sys-color-primary)";
      stEl.textContent = over ? `+${fmt(current - target)} dépassé` : `Reste ${fmt(target - current)}`;
    }
    $(id.sp).textContent = `${fmt(current)} ${isSavings ? 'épargnés' : 'dépensés'}`;
    $(id.ceil).textContent = `${isSavings ? 'Objectif' : 'Plafond'} : ${fmt(target)}`;
  };

  setRule({ pb: "pbObl", st: "stObl", sp: "spObl", ceil: "ceilObl" }, obligationsTotal, incomeTotal * 0.5);
  setRule({ pb: "pbWants", st: "stWants", sp: "spWants", ceil: "ceilWants" }, wantsTotal, incomeTotal * 0.3);
  setRule({ pb: "pbSav", st: "stSav", sp: "spSav", ceil: "ceilSav" }, savingsTotal, incomeTotal * 0.2, true);

  const allExpenses = monthTransactions.filter(t => t.type === "expense" && !t.isReimbursed);
  const fixedItems = allExpenses.filter(t => t.isFixed === true || t.isFixed === "true" || t.isFixed === 1);
  const normalItems = allExpenses.filter(t => !t.isFixed || t.isFixed === "false" || t.isFixed === 0);

  const FIXED_PALETTE = ["#7957FF", "#42D8B2", "#FFD84A", "#FF795A", "#B8DBFF", "#F59BC1"];
  const NORMAL_PALETTE = ["#FF795A", "#FFD84A", "#42D8B2", "#7957FF", "#B8DBFF", "#F59BC1"];

  drawDonut("chartFixed", "fixedTotalBadge", "fixedTotalText", "breakdownFixed", fixedItems, FIXED_PALETTE, "Aucune charge ce mois-ci");
  drawDonut("chartNormal", "normalTotalBadge", "normalTotalText", "breakdownNormal", normalItems, NORMAL_PALETTE, "Aucune dépense courante ce mois-ci");
}

function setModalType(type) {
  modalType = type;
  const isExp = type === "expense";
  $("btnTypeExp").classList.toggle("active", isExp);
  $("btnTypeInc").classList.toggle("active", !isExp);
  $("switchRow").style.display = isExp ? "flex" : "none";
  $("txCat").innerHTML = (CATS[type] || []).map(c => `<option value="${c.id}">${c.label}</option>`).join("");
  updateReimbursedVisibility();
}

function updateReimbursedVisibility() {
  const isSante = modalType === "expense" && $("txCat") && $("txCat").value === "sante";
  $("switchReimbursedRow").style.display = isSante ? "flex" : "none";
  if (!isSante && $("txReimbursedSwitch")) $("txReimbursedSwitch").checked = false;
}

$("txCat").onchange = updateReimbursedVisibility;

const tpe = $("txAmount");
tpe.oninput = () => {
  const d = tpe.value.replace(/\D/g, "");
  tpe.value = d ? (parseInt(d, 10) / 100).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "";
};
const getTPE = () => parseFloat(tpe.value.replace(/\s/g, '').replace(',', '.')) || 0;
const setTPE = v => { tpe.value = v ? Number(v).toLocaleString("fr-FR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ""; };

const dbCategoryToApp = value => {
  const raw = String(value || "").trim();
  if (!raw) return "Divers";
  const exact = ALL_CATS.find(c => c.id === raw || c.label.toLocaleLowerCase("fr-FR") === raw.toLocaleLowerCase("fr-FR"));
  if (exact) return exact.id;
  const aliases = {
    "vtc": "vtc_taxi",
    "supermarchés et hypermarchés": "supermarche",
    "supermarches et hypermarches": "supermarche",
    "transport": "transport_commun",
    "énergie et eau": "energie",
    "energie et eau": "energie",
    "loyer": "logement",
    "téléphone et internet": "abonnement",
    "telephone et internet": "abonnement",
    "frais bancaires": "credit"
  };
  return aliases[raw.toLocaleLowerCase("fr-FR")] || raw;
};

const appCategoryToDb = value => {
  const found = ALL_CATS.find(c => c.id === value);
  return found ? found.label : String(value || "Divers");
};

const rowToTransaction = row => ({
  id: row.id,
  clientEntryId: row.client_entry_id,
  label: row.title || "Sans titre",
  amount: Number(row.amount) || 0,
  type: row.kind === "income" ? "income" : "expense",
  category: dbCategoryToApp(row.category),
  isFixed: row.kind === "fixed",
  isReimbursed: !!row.is_reimbursed,
  date: String(row.occurred_at || "").slice(0, 10)
});

async function loadActiveHousehold() {
  if (!currentUser) return null;
  const { data, error } = await supabase
    .from("profiles")
    .select("active_household_id")
    .eq("id", currentUser.id)
    .single();
  if (error) throw error;
  currentHouseholdId = data?.active_household_id || null;
  if (!currentHouseholdId) throw new Error("Aucun foyer Supabase actif n'a été trouvé.");
  return currentHouseholdId;
}

async function loadTransactions() {
  if (!currentUser || !currentHouseholdId) {
    transactions = [];
    renderApp();
    return;
  }
  const { data, error } = await supabase
    .from("household_transactions")
    .select("id, client_entry_id, month_key, kind, title, amount, category, occurred_at, is_reimbursed")
    .eq("household_id", currentHouseholdId)
    .order("occurred_at", { ascending: false });
  if (error) throw error;
  transactions = (data || []).map(rowToTransaction);
  renderBudgetsSettings();
  renderApp();
}

function stopRealtime() {
  if (realtimeChannel) {
    supabase.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}

function startRealtime() {
  stopRealtime();
  if (!currentHouseholdId) return;
  realtimeChannel = supabase
    .channel(`budget-${currentHouseholdId}`)
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "household_transactions",
      filter: `household_id=eq.${currentHouseholdId}`
    }, async () => {
      try { await loadTransactions(); } catch (err) { console.error(err); }
    })
    .on("postgres_changes", {
      event: "*",
      schema: "public",
      table: "household_budgets",
      filter: `household_id=eq.${currentHouseholdId}`
    }, async () => {
      try { await loadBudgets(); } catch (err) { console.error(err); }
    })
    .subscribe();
}

function setAuthGateVisible(visible) {
  const gate = $("authGate");
  if (!gate) return;
  if (visible) {
    $all(".modal-backdrop.show").forEach(open => open.classList.remove("show"));
    document.body.classList.remove("modal-open");
    document.documentElement.style.overflow = "";
    gate.classList.remove("is-leaving");
    document.body.classList.remove("auth-ready");
    document.body.classList.add("auth-locked");
  } else {
    document.body.classList.add("auth-ready");
    document.body.classList.remove("auth-locked");
    requestAnimationFrame(() => gate.classList.add("is-leaving"));
  }
}

function setAuthStatus(id, message = "", isError = false) {
  const el = $(id);
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", !!isError);
}

function setAuthButtonBusy(button, busy, busyLabel = "Connexion…") {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="auth-spinner" aria-hidden="true"></span><span>${busyLabel}</span>`;
  } else {
    button.disabled = false;
    if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
  }
}

let passwordRecoveryActive = /(?:^|[&#?])type=recovery(?:&|$)/i.test(`${location.search}${location.hash}`);

function showEmailStep(email = "") {
  passwordRecoveryActive = false;
  $("authRecoveryStep").hidden = true;
  $("authEmailStep").hidden = false;
  $("authEmail").value = email || $("authEmail").value || "";
  $("authPassword").value = "";
  $("authRecoveryPassword").value = "";
  $("authRecoveryPasswordConfirm").value = "";
  setAuthStatus("authEmailStatus", "");
  setAuthStatus("authRecoveryStatus", "");
  setAuthGateVisible(true);
  setTimeout(() => $("authEmail")?.focus(), 80);
}

function showRecoveryStep() {
  passwordRecoveryActive = true;
  $("authEmailStep").hidden = true;
  $("authRecoveryStep").hidden = false;
  $("authRecoveryPassword").value = "";
  $("authRecoveryPasswordConfirm").value = "";
  setAuthStatus("authRecoveryStatus", "");
  setAuthGateVisible(true);
  setTimeout(() => $("authRecoveryPassword")?.focus(), 80);
}

async function applyAuthUser(user) {
  currentUser = user || null;
  const dot = $("navAccountDot");
  const indicator = $("navAccountIndicator");
  stopRealtime();

  if (user) {
    setAuthGateVisible(false);
    const meta = user.user_metadata || {};
    const displayName = meta.full_name || meta.name || user.email?.split("@")[0] || "Compte";
    const initials = displayName.charAt(0).toUpperCase();

    if (dot) dot.classList.add("online");
    if (indicator) indicator.innerHTML = `<div style="font-weight:800; font-size:14px;">${initials}</div><div class="account-badge-dot online" id="navAccountDot" style="right:3px; bottom:3px;"></div>`;
    $("accModalAvatar").innerHTML = `<span>${initials}</span>`;
    $("accModalName").textContent = displayName;
    $("accModalEmail").textContent = user.email || "";
    $("accModalStatus").textContent = "• Synchronisé avec Supabase Cloud";
    $("accModalStatus").style.color = "var(--md-sys-color-success)";

    try {
      await loadActiveHousehold();
      await loadTransactions();
      await loadBudgets();
      startRealtime();
    } catch (err) {
      console.error(err);
      transactions = [];
      renderApp();
      notify("Erreur Supabase : " + err.message, "error");
    }
  } else {
    currentHouseholdId = null;
    transactions = [];
    budgets = {};
    renderBudgetsSettings();
    renderApp();
    if (dot) dot.classList.remove("online");
    if (indicator) indicator.innerHTML = `<span class="material-symbols-rounded" id="navAccountIcon">account_circle</span><div class="account-badge-dot" id="navAccountDot" style="right:3px; bottom:3px;"></div>`;
    setAuthGateVisible(true);
  }
}

// Keep the application locked until Supabase tells us whether a session exists.
setAuthGateVisible(true);
const { data: initialSessionData } = await supabase.auth.getSession();
if (passwordRecoveryActive && initialSessionData?.session) showRecoveryStep();
else await applyAuthUser(initialSessionData?.session?.user || null);

supabase.auth.onAuthStateChange(async (event, session) => {
  if (event === "PASSWORD_RECOVERY") {
    showRecoveryStep();
    return;
  }
  if (event === "INITIAL_SESSION" || passwordRecoveryActive) return;
  await applyAuthUser(session?.user || null);
});

let authMode = "login";

function setAuthMode(mode) {
  authMode = mode === "signup" ? "signup" : "login";
  const signup = authMode === "signup";

  $("authModeLogin").classList.toggle("active", !signup);
  $("authModeSignup").classList.toggle("active", signup);
  $("authModeLogin").setAttribute("aria-selected", String(!signup));
  $("authModeSignup").setAttribute("aria-selected", String(signup));
  $("authConfirmWrap").hidden = !signup;
  $("authForgotRow").hidden = signup;

  $("authFormTitle").textContent = signup ? "Créer votre compte" : "Bon retour";
  $("authFormCopy").textContent = signup
    ? "Choisissez votre adresse e-mail et un mot de passe pour créer votre espace Budget."
    : "Connectez-vous avec votre adresse e-mail et votre mot de passe.";
  $("authSubmitLabel").textContent = signup ? "Créer mon compte" : "Se connecter";

  $("authPassword").autocomplete = signup ? "new-password" : "current-password";
  $("authPasswordConfirm").value = "";
  setAuthStatus("authEmailStatus", "");
}

$("authModeLogin").onclick = () => setAuthMode("login");
$("authModeSignup").onclick = () => setAuthMode("signup");

$("authEmailStep").addEventListener("submit", async e => {
  e.preventDefault();

  const email = $("authEmail").value.trim().toLowerCase();
  const password = $("authPassword").value;
  const passwordConfirm = $("authPasswordConfirm").value;
  const btn = $("authSignIn");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setAuthStatus("authEmailStatus", "Entrez une adresse e-mail valide.", true);
    return;
  }
  if (password.length < 6) {
    setAuthStatus("authEmailStatus", "Le mot de passe doit contenir au moins 6 caractères.", true);
    return;
  }
  if (authMode === "signup" && password !== passwordConfirm) {
    setAuthStatus("authEmailStatus", "Les deux mots de passe ne correspondent pas.", true);
    return;
  }

  setAuthStatus("authEmailStatus", "");
  setAuthButtonBusy(btn, true, authMode === "signup" ? "Création du compte…" : "Connexion…");

  try {
    if (authMode === "signup") {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;

      // With email confirmation disabled in Supabase, a session is returned immediately.
      // If confirmation is still enabled, explain what needs to be changed instead of silently failing.
      if (!data?.session) {
        setAuthStatus(
          "authEmailStatus",
          "Compte créé, mais Supabase demande encore une confirmation e-mail. Désactive « Confirm email » dans Authentication → Sign In / Providers → Email pour une inscription sans e-mail.",
          true
        );
        return;
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
    }
  } catch (err) {
    const raw = String(err?.message || "");
    let message = authMode === "signup"
      ? "Impossible de créer le compte."
      : "Connexion impossible. Vérifiez votre e-mail et votre mot de passe.";

    if (/invalid login credentials/i.test(raw)) {
      message = "E-mail ou mot de passe incorrect.";
    } else if (/email not confirmed/i.test(raw)) {
      message = "Ce compte n’est pas encore confirmé dans Supabase.";
    } else if (/already registered|already exists|user already registered/i.test(raw)) {
      message = "Un compte existe déjà avec cette adresse e-mail. Essayez « Se connecter ».";
    } else if (/password/i.test(raw) && /6|short|weak/i.test(raw)) {
      message = "Choisissez un mot de passe d’au moins 6 caractères.";
    } else if (raw) {
      message = raw;
    }

    setAuthStatus("authEmailStatus", message, true);
  } finally {
    setAuthButtonBusy(btn, false);
  }
});

$("authForgotPassword").onclick = async () => {
  const email = $("authEmail").value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setAuthStatus("authEmailStatus", "Entrez d’abord votre adresse e-mail.", true);
    $("authEmail").focus();
    return;
  }

  const btn = $("authForgotPassword");
  btn.disabled = true;
  setAuthStatus("authEmailStatus", "Envoi du lien de réinitialisation…");

  try {
    const redirectTo = /^https?:$/.test(location.protocol)
      ? `${location.origin}${location.pathname}`
      : undefined;
    const { error } = await supabase.auth.resetPasswordForEmail(
      email,
      redirectTo ? { redirectTo } : undefined
    );
    if (error) throw error;
    setAuthStatus("authEmailStatus", "E-mail envoyé. Ouvrez le lien reçu pour choisir un nouveau mot de passe.");
  } catch (err) {
    const raw = String(err?.message || "");
    setAuthStatus("authEmailStatus", raw || "Impossible d’envoyer l’e-mail de réinitialisation.", true);
  } finally {
    btn.disabled = false;
  }
};

$("authRecoveryStep").addEventListener("submit", async e => {
  e.preventDefault();
  const password = $("authRecoveryPassword").value;
  const confirmation = $("authRecoveryPasswordConfirm").value;
  const btn = $("authRecoverySave");

  if (password.length < 6) {
    setAuthStatus("authRecoveryStatus", "Le mot de passe doit contenir au moins 6 caractères.", true);
    return;
  }
  if (password !== confirmation) {
    setAuthStatus("authRecoveryStatus", "Les deux mots de passe ne correspondent pas.", true);
    return;
  }

  setAuthStatus("authRecoveryStatus", "");
  setAuthButtonBusy(btn, true, "Mise à jour…");

  try {
    const { data, error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
    passwordRecoveryActive = false;
    if (location.hash) history.replaceState(null, "", `${location.pathname}${location.search}`);
    await applyAuthUser(data?.user || null);
    notify("Mot de passe mis à jour", "check_circle");
  } catch (err) {
    const raw = String(err?.message || "");
    setAuthStatus("authRecoveryStatus", raw || "Impossible de modifier le mot de passe.", true);
  } finally {
    setAuthButtonBusy(btn, false);
  }
});

$("authTogglePassword").onclick = () => {
  const input = $("authPassword");
  const icon = $("authTogglePasswordIcon");
  const hidden = input.type === "password";
  input.type = hidden ? "text" : "password";
  icon.textContent = hidden ? "visibility_off" : "visibility";
  $("authTogglePassword").setAttribute("aria-label", hidden ? "Masquer le mot de passe" : "Afficher le mot de passe");
};

$("btnSwitchAccount").onclick = async () => {
  const previousEmail = currentUser?.email || "";
  modal("modalAccount", false);
  await supabase.auth.signOut();
  showEmailStep(previousEmail);
};

$("btnSyncNow").onclick = async () => {
  try {
    await loadTransactions();
    notify("Données synchronisées avec Supabase", "sync");
    modal("modalAccount", false);
  } catch (err) {
    notify("Erreur de synchronisation : " + err.message, "error");
  }
};

$("btnAccountLogout").onclick = async () => {
  const previousEmail = currentUser?.email || "";
  modal("modalAccount", false);
  await supabase.auth.signOut();
  showEmailStep(previousEmail);
};

const clampDateToMonth = (sourceDate, targetMonthKey) => {
  const [sourceY, sourceM, sourceD] = String(sourceDate || "").split("-").map(Number);
  const [targetY, targetM] = String(targetMonthKey || "").split("-").map(Number);
  if (![targetY, targetM].every(Number.isFinite)) return sourceDate;
  const wantedDay = Number.isFinite(sourceD) ? sourceD : 1;
  const lastDay = new Date(targetY, targetM, 0).getDate();
  const day = Math.min(Math.max(1, wantedDay), lastDay);
  return `${targetY}-${String(targetM).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
};

const monthKeyOffset = (monthKey, delta) => {
  const [y, m] = String(monthKey || "").split("-").map(Number);
  const d = new Date(y, (m || 1) - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

async function rescheduleTransaction(txId, targetMonthKey) {
  if (!currentUser || !currentHouseholdId || !txId) return;
  const tx = transactions.find(t => t.id === txId);
  if (!tx) return;
  const newDate = clampDateToMonth(tx.date, targetMonthKey);
  try {
    const { error } = await supabase
      .from("household_transactions")
      .update({
        month_key: newDate.slice(0, 7),
        occurred_at: `${newDate}T12:00:00Z`
      })
      .eq("id", txId);
    if (error) throw error;
    await loadTransactions();
    modal("modalReportTx", false);
    notify(`Opération reportée au ${new Date(`${newDate}T12:00:00`).toLocaleDateString("fr-FR", { day:"numeric", month:"long", year:"numeric" })}`, "event_repeat");
  } catch (err) {
    notify("Erreur lors du report : " + err.message, "error");
  }
}

function openReportTx(txId) {
  const tx = transactions.find(t => t.id === txId);
  if (!tx) return;
  selectedId = tx.id;
  $("reportTxTitle").textContent = "Reporter l'opération";
  $("reportTxSub").textContent = `${tx.label} · ${fmt(tx.amount)} · ${new Date(`${tx.date}T12:00:00`).toLocaleDateString("fr-FR", { day:"numeric", month:"long", year:"numeric" })}`;
  modal("modalReportTx", true);
}

const clearTxLongPress = () => {
  if (longPressTimer) clearTimeout(longPressTimer);
  longPressTimer = null;
  longPressStart = null;
};

$("txContainer").addEventListener("pointerdown", e => {
  const item = e.target.closest(".tx-item");
  if (!item || e.button !== 0) return;
  clearTxLongPress();
  longPressStart = { x:e.clientX, y:e.clientY, id:item.dataset.id };
  longPressTimer = setTimeout(() => {
    if (!longPressStart) return;
    longPressConsumedId = longPressStart.id;
    if (navigator.vibrate) navigator.vibrate(18);
    openReportTx(longPressStart.id);
    clearTxLongPress();
  }, 560);
});

$("txContainer").addEventListener("pointermove", e => {
  if (!longPressStart) return;
  if (Math.hypot(e.clientX - longPressStart.x, e.clientY - longPressStart.y) > 10) clearTxLongPress();
});
$("txContainer").addEventListener("pointerup", clearTxLongPress);
$("txContainer").addEventListener("pointercancel", clearTxLongPress);
$("txContainer").addEventListener("pointerleave", e => {
  if (e.pointerType === "mouse") clearTxLongPress();
});
$("txContainer").addEventListener("contextmenu", e => {
  if (e.target.closest(".tx-item")) e.preventDefault();
});

$("txContainer").onclick = e => {
  const weekToggle = e.target.closest(".week-group-heading");
  if (weekToggle) {
    const weekKey = weekToggle.dataset.week;
    if (!weekKey || searchQuery.trim()) return;
    const currentlyCollapsed = weekGroupCollapsedState.has(weekKey)
      ? weekGroupCollapsedState.get(weekKey)
      : true;
    weekGroupCollapsedState.set(weekKey, !currentlyCollapsed);
    renderApp();
    return;
  }

  const groupToggle = e.target.closest(".date-group-heading");
  if (groupToggle) {
    const date = groupToggle.dataset.date;
    if (!date || searchQuery.trim()) return;
    const currentlyCollapsed = dateGroupCollapsedState.has(date)
      ? dateGroupCollapsedState.get(date)
      : shouldCollapseDateGroupByDefault(date);
    dateGroupCollapsedState.set(date, !currentlyCollapsed);
    renderApp();
    return;
  }

  const item = e.target.closest(".tx-item");
  if (!item) return;
  if (longPressConsumedId && longPressConsumedId === item.dataset.id) {
    longPressConsumedId = null;
    return;
  }
  selectedId = item.dataset.id;
  const t = transactions.find(x => x.id === selectedId);
  if (!t) return;
  $("actTitle").textContent = t.label;
  $("actSub").textContent = `${t.type === 'expense' ? 'Dépense de' : 'Revenu de'} ${fmt(t.amount)}`;
  modal("modalAction", true);
};

$all("[data-close]").forEach(b => b.onclick = () => modal(b.dataset.close, false));

// Tap the empty/dimmed area to dismiss the presented sheet.
$all(".modal-backdrop").forEach(backdrop => {
  backdrop.addEventListener("click", e => {
    if (e.target === backdrop) modal(backdrop.id, false);
  });
});

// Escape = dismiss on desktop/iPad keyboard.
document.addEventListener("keydown", e => {
  if (e.key !== "Escape") return;
  const open = [...$all(".modal-backdrop.show")].at(-1);
  if (open) {
    e.preventDefault();
    modal(open.id, false);
  }
});

// iOS-style swipe-down gesture from the sheet handle.
$all(".modal-backdrop .sheet").forEach(sheet => {
  const backdrop = sheet.closest(".modal-backdrop");
  const handle = sheet.querySelector(".sheet-handle");
  if (!backdrop || !handle) return;

  let pointerId = null;
  let startY = 0;
  let lastY = 0;
  let startTime = 0;

  const finishDrag = (dismiss = false) => {
    if (pointerId !== null) {
      try { handle.releasePointerCapture(pointerId); } catch (_) {}
    }

    sheet.classList.remove("is-dragging");

    if (dismiss) {
      sheet.style.transform = "translate3d(0, 110%, 0)";
      sheet.style.opacity = ".5";
      window.setTimeout(() => modal(backdrop.id, false), 180);
    } else {
      sheet.style.transform = "translate3d(0,0,0)";
      sheet.style.opacity = "1";
      window.setTimeout(() => {
        if (!backdrop.classList.contains("show")) return;
        sheet.style.transform = "";
        sheet.style.opacity = "";
      }, 280);
    }

    pointerId = null;
  };

  handle.addEventListener("pointerdown", e => {
    if (!backdrop.classList.contains("show")) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;

    pointerId = e.pointerId;
    startY = lastY = e.clientY;
    startTime = performance.now();
    sheet.classList.add("is-dragging");

    try { handle.setPointerCapture(pointerId); } catch (_) {}
  });

  handle.addEventListener("pointermove", e => {
    if (pointerId !== e.pointerId) return;

    const dy = Math.max(0, e.clientY - startY);
    lastY = e.clientY;

    // Slight resistance, like an iOS sheet.
    const translated = dy <= 180 ? dy : 180 + (dy - 180) * .32;
    sheet.style.transform = `translate3d(0, ${translated}px, 0)`;
    sheet.style.opacity = String(Math.max(.68, 1 - translated / 760));
  });

  handle.addEventListener("pointerup", e => {
    if (pointerId !== e.pointerId) return;

    const dy = Math.max(0, lastY - startY);
    const elapsed = Math.max(1, performance.now() - startTime);
    const velocity = dy / elapsed; // px/ms

    finishDrag(dy > 92 || velocity > .55);
  });

  handle.addEventListener("pointercancel", () => {
    if (pointerId !== null) finishDrag(false);
  });
});


// Calendrier custom pour Nouvelle opération / Modifier l’opération.
let txDatePickerCursor = new Date();

const formatTxDateLabel = key => {
  const date = parseTxDate(key);
  if (!date) return "Choisir une date";
  return date.toLocaleDateString("fr-FR", { day:"numeric", month:"long", year:"numeric" });
};

const setTransactionDate = key => {
  const date = parseTxDate(key);
  const normalized = date ? toLocalDateKey(date) : toLocalDateKey(new Date());
  $("txDate").value = normalized;
  $("txDateLabel").textContent = formatTxDateLabel(normalized);
};

const renderTxDatePicker = () => {
  const grid = $("txDatePickerGrid");
  if (!grid) return;

  const year = txDatePickerCursor.getFullYear();
  const month = txDatePickerCursor.getMonth();
  $("txDatePickerTitle").textContent = new Intl.DateTimeFormat("fr-FR", { month:"long", year:"numeric" }).format(new Date(year, month, 1));

  const selectedKey = $("txDate").value;
  const todayKey = toLocalDateKey(new Date());
  const firstDay = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const mondayOffset = (firstDay.getDay() + 6) % 7;

  let html = "";
  for (let i = 0; i < mondayOffset; i++) html += `<div class="tx-date-grid-cell" aria-hidden="true"></div>`;
  for (let day = 1; day <= daysInMonth; day++) {
    const key = `${year}-${String(month + 1).padStart(2,"0")}-${String(day).padStart(2,"0")}`;
    const selected = key === selectedKey;
    const today = key === todayKey;
    html += `<div class="tx-date-grid-cell"><button type="button" class="tx-date-day ios-press ${selected ? "is-selected" : ""} ${today ? "is-today" : ""}" data-date="${key}" aria-pressed="${selected ? "true" : "false"}">${day}</button></div>`;
  }
  grid.innerHTML = html;
  grid.querySelectorAll(".tx-date-day").forEach(btn => {
    btn.onclick = () => {
      setTransactionDate(btn.dataset.date);
      closeTxDatePicker();
    };
  });
};

const openTxDatePicker = () => {
  const selected = parseTxDate($("txDate").value) || new Date();
  txDatePickerCursor = new Date(selected.getFullYear(), selected.getMonth(), 1);
  renderTxDatePicker();
  $("txDatePickerBackdrop").classList.add("show");
  $("txDatePickerBackdrop").setAttribute("aria-hidden", "false");
  $("txDateButton").setAttribute("aria-expanded", "true");
};

const closeTxDatePicker = () => {
  $("txDatePickerBackdrop").classList.remove("show");
  $("txDatePickerBackdrop").setAttribute("aria-hidden", "true");
  $("txDateButton").setAttribute("aria-expanded", "false");
};

const shiftTxDatePickerMonth = delta => {
  txDatePickerCursor = new Date(txDatePickerCursor.getFullYear(), txDatePickerCursor.getMonth() + delta, 1);
  renderTxDatePicker();
};

$("txDateButton").onclick = openTxDatePicker;
$("txDatePickerPrev").onclick = () => shiftTxDatePickerMonth(-1);
$("txDatePickerNext").onclick = () => shiftTxDatePickerMonth(1);
$("txDatePickerClose").onclick = closeTxDatePicker;
$("txDatePickerToday").onclick = () => { setTransactionDate(toLocalDateKey(new Date())); closeTxDatePicker(); };
$("txDatePickerBackdrop").addEventListener("click", e => { if (e.target === $("txDatePickerBackdrop")) closeTxDatePicker(); });
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && $("txDatePickerBackdrop").classList.contains("show")) {
    e.stopImmediatePropagation();
    closeTxDatePicker();
  }
}, true);

$("btnNavAccount").onclick = () => modal("modalAccount", true);

$("openAdd").onclick = () => {
  editingId = null;
  $("modalTxTitle").textContent = "Nouvelle opération";
  $("txLabel").value = "";
  setTPE(0);
  setTransactionDate(toLocalDateKey(new Date()));
  $("txSwitch").checked = false;
  $("txReimbursedSwitch").checked = false;
  setModalType("expense");
  modal("modalTx", true);
};

$("btnTypeExp").onclick = () => setModalType("expense");
$("btnTypeInc").onclick = () => setModalType("income");

$("btnSaveTx").onclick = async () => {
  if (!currentUser) return notify("Veuillez d'abord vous connecter", "error");
  const label = $("txLabel").value.trim();
  const amount = getTPE();
  const cat = $("txCat").value;
  const date = $("txDate").value || new Date().toISOString().slice(0, 10);
  if (!label || amount <= 0) return notify("Veuillez saisir un libellé et un montant", "error");

  const isFixed = modalType === "expense" && $("txSwitch").checked;
  const isReimbursed = modalType === "expense" && cat === "sante" && $("txReimbursedSwitch").checked;
  if (!currentHouseholdId) return notify("Aucun foyer Supabase actif", "error");
  const kind = modalType === "income" ? "income" : (isFixed ? "fixed" : "variable");
  const payload = {
    household_id: currentHouseholdId,
    month_key: date.slice(0, 7),
    kind,
    title: label,
    amount,
    category: appCategoryToDb(cat),
    subcategory: "",
    owner_key: "",
    note: "",
    occurred_at: `${date}T12:00:00Z`,
    is_reimbursed: isReimbursed
  };

  try {
    let error;
    if (editingId) {
      ({ error } = await supabase.from("household_transactions").update(payload).eq("id", editingId));
    } else {
      payload.client_entry_id = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
      ({ error } = await supabase.from("household_transactions").insert(payload));
    }
    if (error) throw error;
    await loadTransactions();
    modal("modalTx", false);
    notify("Opération enregistrée dans Supabase", "cloud_done");
  } catch (err) {
    notify("Erreur d'enregistrement : " + err.message, "error");
  }
};

$("btnActEdit").onclick = () => {
  modal("modalAction", false);
  const t = transactions.find(x => x.id === selectedId);
  if (!t) return;
  editingId = t.id;
  $("modalTxTitle").textContent = "Modifier l'opération";
  $("txLabel").value = t.label;
  setTPE(t.amount);
  setTransactionDate(t.date);
  setModalType(t.type);
  if (![...$("txCat").options].some(o => o.value === t.category)) {
    const opt = document.createElement("option");
    opt.value = t.category;
    opt.textContent = t.category || "Divers";
    $("txCat").appendChild(opt);
  }
  $("txCat").value = t.category;
  $("txSwitch").checked = (t.isFixed === true || t.isFixed === "true" || t.isFixed === 1);
  $("txReimbursedSwitch").checked = !!t.isReimbursed;
  updateReimbursedVisibility();
  modal("modalTx", true);
};

$("btnActDel").onclick = async () => {
  if (!currentUser || !selectedId) return;
  try {
    const { error } = await supabase.from("household_transactions").delete().eq("id", selectedId);
    if (error) throw error;
    await loadTransactions();
    modal("modalAction", false);
    notify("Opération supprimée", "delete");
  } catch (err) {
    notify("Erreur de suppression : " + err.message, "error");
  }
};

$("btnReportNextMonth").onclick = async () => {
  const tx = transactions.find(t => t.id === selectedId);
  if (!tx) return;
  await rescheduleTransaction(tx.id, monthKeyOffset(tx.date.slice(0, 7), 1));
};

$("btnReportChooseMonth").onclick = () => {
  const tx = transactions.find(t => t.id === selectedId);
  if (!tx) return;
  rescheduleTxId = tx.id;
  monthPickerMode = "reschedule";
  modal("modalReportTx", false);
  openMonthPicker(tx.date.slice(0, 7));
};

const secHeader = $("secHeader");
const searchInp = $("searchInput");

const openSearch = () => {
  secHeader.classList.add("searching");
  setTimeout(() => searchInp.focus(), 80);
};

const closeSearch = () => {
  secHeader.classList.remove("searching");
  searchInp.value = searchQuery = "";
  renderApp();
};

$("btnOpenSearch").onclick = openSearch;
$("btnCloseSearch").onclick = closeSearch;

searchInp.oninput = e => {
  searchQuery = e.target.value;
  renderApp();
};

searchInp.onkeydown = e => {
  if (e.key === "Escape") closeSearch();
};

// Gestion des onglets et du bouton Compte en bas à droite
$("navBar").onclick = e => {
  const item = e.target.closest(".nav-item");
  if (!item) return;

  if (item.id === "btnNavAccount") {
    modal("modalAccount", true);
    return;
  }

  if (item.id === "btnNavAdd") {
    $("openAdd").click();
    return;
  }

  $all(".nav-item").forEach(i => i.classList.remove("active"));
  $all(".screen").forEach(s => s.classList.remove("active"));
  item.classList.add("active");
  const target = $(item.dataset.target);
  if (target) target.classList.add("active");

  $("openAdd").style.display = item.dataset.target === "screenOperations" ? "flex" : "none";
  window.scrollTo(0, 0);

  if (item.dataset.target === "screenAnalytics") {
    setTimeout(() => renderAnalytics(), 50);
  }
};

$("filterChips").onclick = e => {
  const chip = e.target.closest(".ios-filter");
  if (!chip) return;
  $all("#filterChips .ios-filter").forEach(c => c.classList.remove("active"));
  chip.classList.add("active");
  currentFilter = chip.dataset.filter;
  renderApp();
};

function applyTheme(themeVal) {
  document.documentElement.setAttribute("data-theme", themeVal);
  try { localStorage.setItem("budget_theme", themeVal); } catch(e){}
  $all("#themeSwitch .ios-segmented-btn").forEach(b => b.classList.toggle("active", b.dataset.themeVal === themeVal));
  renderAnalytics();
}

$("btnTriggerImport").onclick = () => $("jsonFileInput").click();
$("jsonFileInput").onchange = e => {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async evt => {
    try {
      if (!currentUser) return notify("Connectez-vous avant d'importer", "error");
      if (!currentHouseholdId) return notify("Aucun foyer Supabase actif", "error");

      const raw = JSON.parse(evt.target.result);

      // Compatibilité avec les anciens exports : un simple tableau reste importable.
      const list = Array.isArray(raw)
        ? raw
        : (Array.isArray(raw?.transactions) ? raw.transactions : []);

      const importedBudgets = !Array.isArray(raw) && raw?.budgets && typeof raw.budgets === "object"
        ? raw.budgets
        : {};

      const budgetRows = Object.entries(importedBudgets).map(([category, amount]) => ({
        household_id: currentHouseholdId,
        category,
        monthly_amount: Math.max(0, Number(amount) || 0)
      }));

      if (!list.length && !budgetRows.length) {
        return notify("Aucune donnée trouvée dans ce fichier", "error");
      }

      // Opérations : import par lots, comme avant.
      for (let i = 0; i < list.length; i += 300) {
        const rows = list.slice(i, i + 300).map(t => {
          const date = t.date || new Date().toISOString().slice(0, 10);
          const type = t.type === "income" ? "income" : "expense";
          const isFixed = type === "expense" && !!t.isFixed;
          return {
            household_id: currentHouseholdId,
            client_entry_id: t.clientEntryId || t.client_entry_id || (t.id ? `legacy:${String(t.id)}` : (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)),
            month_key: date.slice(0, 7),
            kind: type === "income" ? "income" : (isFixed ? "fixed" : "variable"),
            title: t.label || t.title || "Sans titre",
            amount: Number(t.amount) || 0,
            category: appCategoryToDb(t.category || "supermarche"),
            subcategory: "",
            owner_key: "",
            note: "",
            occurred_at: `${date}T12:00:00Z`,
            is_reimbursed: !!(t.isReimbursed ?? t.is_reimbursed)
          };
        });

        const { error } = await supabase
          .from("household_transactions")
          .upsert(rows, { onConflict: "household_id,client_entry_id" });

        if (error) throw error;
      }

      // Budgets : ajout/mise à jour non destructive des catégories présentes dans la sauvegarde.
      if (budgetRows.length) {
        const { error } = await supabase
          .from("household_budgets")
          .upsert(budgetRows, { onConflict: "household_id,category" });

        if (error) throw error;
      }

      await loadTransactions();
      await loadBudgets();

      const imported = [];
      if (list.length) imported.push(`${list.length} opération${list.length > 1 ? "s" : ""}`);
      if (budgetRows.length) imported.push(`${budgetRows.length} budget${budgetRows.length > 1 ? "s" : ""}`);

      notify(`${imported.join(" et ")} importé${imported.length > 1 || list.length > 1 || budgetRows.length > 1 ? "s" : ""} dans Supabase`, "cloud_done");
    } catch (err) {
      console.error(err);
      notify("Erreur d'import : " + (err?.message || "fichier JSON invalide"), "error");
    } finally {
      $("jsonFileInput").value = "";
    }
  };
  reader.readAsText(file);
};

const buildExpensesCsv = expenses => {
  // Quoted cells preserve separators, quotes and line breaks; neutralize spreadsheet formulas.
  const cell = value => {
    let text = String(value ?? "");
    if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const rows = [["Date", "Libellé", "Catégorie", "Montant (EUR)", "Type", "Remboursée"]];
  expenses.forEach(t => rows.push([
    t.date,
    t.label,
    ALL_CATS.find(c => c.id === t.category)?.label || t.category || "Divers",
    (Number(t.amount) || 0).toFixed(2).replace(".", ","),
    (t.isFixed === true || t.isFixed === "true" || t.isFixed === 1) ? "Fixe" : "Variable",
    t.isReimbursed ? "Oui" : "Non"
  ]));
  // UTF-8 BOM keeps French accents intact when opened in Excel.
  return "\uFEFF" + rows.map(row => row.map(cell).join(";")).join("\r\n") + "\r\n";
};

$("btnExportCsv").onclick = () => {
  const expenses = getCurrentMonthTransactions().filter(t => t.type === "expense");
  if (!expenses.length) return notify("Aucune dépense à exporter pour ce mois", "info");

  let url;
  const link = document.createElement("a");
  try {
    const blob = new Blob([buildExpensesCsv(expenses)], { type: "text/csv;charset=utf-8;" });
    url = URL.createObjectURL(blob);
    link.href = url;
    link.download = `depenses_${currentMonth}.csv`;
    document.body.appendChild(link);
    link.click();
    notify("Export CSV lancé", "download");
  } catch (err) {
    notify("Impossible d'exporter les dépenses en CSV", "error");
  } finally {
    link.remove();
    // Leave time for the browser to start reading the download.
    if (url) setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
};

const buildExportFile = () => {
  const backup = {
    version: 2,
    exportedAt: new Date().toISOString(),
    transactions,
    budgets
  };

  const json = JSON.stringify(backup, null, 2);
  const filename = `budget_${currentMonth}.json`;
  const blob = new Blob([json], { type: "application/json" });
  const file = new File([blob], filename, { type: "application/json" });
  return { json, filename, blob, file };
};

$("btnShareExport").onclick = async () => {
  const { file, filename, json } = buildExportFile();

  try {
    if (!navigator.share) {
      notify("Partage natif indisponible", "error");
      return;
    }

    const shareData = {
      title: "Sauvegarde Budget",
      text: `Sauvegarde complète — opérations et budgets — ${currentMonth}`
    };

    if (navigator.canShare?.({ files: [file] })) {
      shareData.files = [file];
    } else {
      shareData.text += `\n\n${json}`;
    }

    await navigator.share(shareData);
  } catch (err) {
    if (err?.name !== "AbortError") {
      notify("Impossible de partager le fichier", "error");
    }
  }
};


let savedPalette = "blue";
try { savedPalette = localStorage.getItem("budget_ios_color") || localStorage.getItem("budget_pixel_color") || "blue"; } catch(e){}
document.documentElement.setAttribute("data-color", savedPalette);
$all(".color-dot").forEach(d => {
  const isActive = d.dataset.palette === savedPalette;
  d.classList.toggle("active", isActive);
  d.querySelector(".material-symbols-rounded").style.display = isActive ? "block" : "none";
});

let savedTheme = "auto";
try { savedTheme = localStorage.getItem("budget_theme") || "auto"; } catch(e){}
applyTheme(savedTheme);

renderBudgetsSettings();
bindCollapsibleSettingsSection(
  "budgetSettingsToggle", "budgetSettingsContent", "les budgets par catégorie"
);
bindCollapsibleSettingsSection(
  "dataSettingsToggle", "dataSettingsContent", "la sauvegarde et les données"
);

const MONTH_NAMES = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
let monthPickerYear = Number(currentMonth.split("-")[0]) || new Date().getFullYear();

const updateMonth = () => {
  const [y, m] = currentMonth.split("-");
  $("monthLabel").textContent = `${MONTH_NAMES[Number(m) - 1]} ${y}`;
};

const shiftCurrentMonth = delta => {
  const [year, month] = currentMonth.split("-").map(Number);
  const next = new Date(year, month - 1 + delta, 1);
  currentMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  monthPickerYear = next.getFullYear();
  updateMonth();
  renderBudgetsSettings();
  renderApp();
  if ($("monthPickerBackdrop")?.classList.contains("show")) renderMonthPicker();
};

const getMonthPickerTrigger = () => {
  if (monthPickerMode === "comparison-primary") return $("comparisonMonthPrimaryButton");
  if (monthPickerMode === "comparison-reference") return $("comparisonMonthReferenceButton");
  return $("btnMonthPicker");
};

const getSelectedMonthForPicker = () => {
  if (monthPickerMode === "reschedule") {
    return transactions.find(t => t.id === rescheduleTxId)?.date?.slice(0, 7) || currentMonth;
  }
  if (monthPickerMode === "comparison-primary") return comparedMonth;
  if (monthPickerMode === "comparison-reference") return referenceMonth;
  return currentMonth;
};

const applyComparisonMonthSelection = monthKey => {
  if (monthPickerMode === "comparison-primary") comparedMonth = monthKey;
  else if (monthPickerMode === "comparison-reference") referenceMonth = monthKey;
  else return false;

  renderMonthlyComparison();
  return true;
};

const MONTH_PICKER_KICKERS = {
  reschedule: "REPORTER VERS",
  "comparison-primary": "MOIS À COMPARER",
  "comparison-reference": "MOIS DE RÉFÉRENCE",
  navigate: "CHOISIR UN MOIS"
};

const renderMonthPicker = () => {
  const grid = $("monthPickerGrid");
  if (!grid) return;
  $("monthPickerTitle").textContent = String(monthPickerYear);
  const selectedKey = getSelectedMonthForPicker();
  const [selectedYear, selectedMonth] = selectedKey.split("-").map(Number);
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonthNumber = now.getMonth() + 1;
  const kicker = $("monthPickerPanel")?.querySelector(".month-picker-kicker");
  if (kicker) kicker.textContent = MONTH_PICKER_KICKERS[monthPickerMode] || MONTH_PICKER_KICKERS.navigate;
  if ($("monthPickerToday")) $("monthPickerToday").textContent = "Ce mois";
  grid.innerHTML = MONTH_NAMES.map((label, index) => {
    const monthNumber = index + 1;
    const selected = selectedYear === monthPickerYear && selectedMonth === monthNumber;
    const isCurrent = currentYear === monthPickerYear && currentMonthNumber === monthNumber;
    return `<button class="month-picker-month ios-press ${selected ? 'is-selected' : ''} ${isCurrent ? 'is-current' : ''}" type="button" data-month="${monthNumber}" aria-pressed="${selected ? 'true' : 'false'}">${label}</button>`;
  }).join("");
  grid.querySelectorAll(".month-picker-month").forEach(btn => {
    btn.onclick = async () => {
      const month = String(Number(btn.dataset.month)).padStart(2, "0");
      const targetMonth = `${monthPickerYear}-${month}`;
      if (monthPickerMode === "reschedule" && rescheduleTxId) {
        const txId = rescheduleTxId;
        closeMonthPicker();
        await rescheduleTransaction(txId, targetMonth);
        return;
      }
      if (applyComparisonMonthSelection(targetMonth)) {
        closeMonthPicker();
        return;
      }
      currentMonth = targetMonth;
      updateMonth();
      renderBudgetsSettings();
      renderApp();
      closeMonthPicker();
    };
  });
};

const openMonthPicker = (initialMonthKey = null) => {
  const key = initialMonthKey || currentMonth;
  monthPickerYear = Number(key.split("-")[0]) || new Date().getFullYear();
  renderMonthPicker();
  $("monthPickerBackdrop").classList.add("show");
  $("monthPickerBackdrop").setAttribute("aria-hidden", "false");
  getMonthPickerTrigger()?.setAttribute("aria-expanded", "true");
};

const closeMonthPicker = () => {
  getMonthPickerTrigger()?.setAttribute("aria-expanded", "false");
  $("monthPickerBackdrop").classList.remove("show");
  $("monthPickerBackdrop").setAttribute("aria-hidden", "true");
  if (monthPickerMode === "reschedule") {
    rescheduleTxId = null;
  }
  monthPickerMode = "navigate";
};

updateMonth();
$("btnPrevMonth").onclick = () => shiftCurrentMonth(-1);
$("btnMonthPicker").onclick = () => {
  monthPickerMode = "navigate";
  rescheduleTxId = null;
  openMonthPicker();
};
$("comparisonMonthPrimaryButton").onclick = () => {
  monthPickerMode = "comparison-primary";
  openMonthPicker(comparedMonth);
};
$("comparisonMonthReferenceButton").onclick = () => {
  monthPickerMode = "comparison-reference";
  openMonthPicker(referenceMonth);
};
$("btnNextMonth").onclick = () => shiftCurrentMonth(1);
$("monthPickerPrevYear").onclick = () => { monthPickerYear -= 1; renderMonthPicker(); };
$("monthPickerNextYear").onclick = () => { monthPickerYear += 1; renderMonthPicker(); };
$("monthPickerClose").onclick = closeMonthPicker;
$("monthPickerToday").onclick = async () => {
  const now = new Date();
  const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  if (monthPickerMode === "reschedule" && rescheduleTxId) {
    const txId = rescheduleTxId;
    closeMonthPicker();
    await rescheduleTransaction(txId, thisMonth);
    return;
  }
  if (applyComparisonMonthSelection(thisMonth)) {
    closeMonthPicker();
    return;
  }
  currentMonth = thisMonth;
  monthPickerYear = now.getFullYear();
  updateMonth();
  renderBudgetsSettings();
  renderApp();
  closeMonthPicker();
};
$("monthPickerBackdrop").addEventListener("click", e => {
  if (e.target === $("monthPickerBackdrop")) closeMonthPicker();
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && $("monthPickerBackdrop").classList.contains("show")) closeMonthPicker();
});

// Keep bottom navigation always visible and anchored low.
const navBar = $("navBar");
if (navBar) navBar.classList.remove("compact");

window.addEventListener("resize", () => refreshBudgetRowSizing(document));


(() => {
  const prompt = document.getElementById('updatePrompt');
  const later = document.getElementById('updateLater');
  const reload = document.getElementById('updateReload');
  let baseline = null;
  let dismissedHash = null;

  async function sha256(text) {
    if (!window.crypto?.subtle) return String(text.length) + ':' + text.slice(0,64);
    const data = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2,'0')).join('');
  }

  async function fetchCurrentHash() {
    if (!/^https?:$/.test(location.protocol)) return null;
    const pageUrl = new URL(location.href);
    pageUrl.hash = '';
    const assetUrls = [pageUrl, new URL('styles.css', pageUrl), new URL('app.js', pageUrl)];
    const version = Date.now().toString();
    const contents = await Promise.all(assetUrls.map(async assetUrl => {
      assetUrl.searchParams.set('_version_check', version);
      const response = await fetch(assetUrl.toString(), { cache:'no-store', headers:{ 'Cache-Control':'no-cache' } });
      if (!response.ok) throw new Error(`Impossible de vérifier ${assetUrl.pathname}`);
      return response.text();
    }));
    return sha256(contents.join('\n'));
  }

  async function checkForUpdate() {
    try {
      const hash = await fetchCurrentHash();
      if (!hash) return;
      if (!baseline) { baseline = hash; return; }
      if (hash !== baseline && hash !== dismissedHash) {
        prompt?.classList.add('show');
        document.body.classList.add('update-curtain-open');
        document.documentElement.style.overflow = 'hidden';
      }
    } catch (_) { /* Offline or local file: silently skip update detection. */ }
  }

  later?.addEventListener('click', async () => {
    dismissedHash = await fetchCurrentHash();
    prompt?.classList.remove('show');
    document.body.classList.remove('update-curtain-open');
    document.documentElement.style.overflow = '';
  });
  reload?.addEventListener('click', () => location.reload());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForUpdate(); });
  window.addEventListener('online', checkForUpdate);
  checkForUpdate();
  setInterval(checkForUpdate, 60000);
})();

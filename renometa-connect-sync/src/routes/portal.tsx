// src/routes/portal.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, useRef } from "react";
import { Loader2, CheckCircle2, Clock, AlertCircle, FileText, MessageSquare, CreditCard, Building2, Phone, ChevronRight, Send, X, Download } from "lucide-react";

export const Route = createFileRoute("/portal")({
  component: ClientPortal,
});

type PortalData = {
  client:    { name: string; email: string };
  org:       { name: string; phone: string | null; logo: string | null; primaryColor: string };
  projects:  Project[];
  estimates: Estimate[];
  invoices:  Invoice[];
  notes:     Note[];
  files:     ProjectFile[];
};

type Project = {
  id: string; name: string; status: string; address: string | null;
  start_date: string | null; end_date: string | null;
  budget_total: number; completion_percentage: number; description: string | null;
};
type Estimate = {
  id: string; number: string | null; title: string; total: number; client_total: number | null;
  status: string; esign_status: string | null; created_at: string; valid_until: string | null; pdf_url: string | null;
};
type Invoice = {
  id: string; invoice_number: string; total_amount: number; amount_paid: number;
  status: string; due_date: string | null; issue_date: string;
};
type Note = {
  id: string; project_id: string; body: string; author: string;
  is_client_message: boolean; client_email: string | null; created_at: string;
};
type ProjectFile = {
  id: string; project_id: string; file_name: string; file_type: string | null;
  mime_type: string | null; file_path: string; description: string | null; created_at: string;
};

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  planning:    { label: "Planning",    color: "#6B7280", bg: "#F3F4F6", icon: <Clock className="h-3.5 w-3.5" /> },
  in_progress: { label: "In Progress", color: "#2563EB", bg: "#EFF6FF", icon: <AlertCircle className="h-3.5 w-3.5" /> },
  on_hold:     { label: "On Hold",     color: "#D97706", bg: "#FFFBEB", icon: <Clock className="h-3.5 w-3.5" /> },
  completed:   { label: "Completed",   color: "#059669", bg: "#ECFDF5", icon: <CheckCircle2 className="h-3.5 w-3.5" /> },
};

function fmt(date: string | null) {
  if (!date) return "—";
  return new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
function fmtMoney(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n);
}

function ProgressBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="h-2 w-full rounded-full bg-gray-100 overflow-hidden">
      <div className="h-full rounded-full transition-all duration-700"
        style={{ width: `${Math.min(pct, 100)}%`, background: color }} />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.planning;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{ color: cfg.color, background: cfg.bg }}>
      {cfg.icon}{cfg.label}
    </span>
  );
}

export function ClientPortal() {
  const search  = new URLSearchParams(window.location.search);
  const token   = search.get("token");

  const [data,      setData]      = useState<PortalData | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"overview" | "estimates" | "invoices" | "messages" | "files">("overview");
  const [activeProject, setActiveProject] = useState<string | null>(null);
  const [message,   setMessage]   = useState("");
  const [sending,   setSending]   = useState(false);
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!token) { setError("No access token provided."); setLoading(false); return; }
    fetch(`/.netlify/functions/portal-data?token=${token}`)
      .then(r => r.json())
      .then(d => {
        if (d.error) { setError(d.error); return; }
        setData(d);
        if (d.projects?.length) setActiveProject(d.projects[0].id);
      })
      .catch(() => setError("Failed to load portal data."))
      .finally(() => setLoading(false));
  }, [token]);

  useEffect(() => {
    if (activeTab === "messages") {
      setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
    }
  }, [activeTab, data?.notes]);

  const doAction = async (action: string, payload: any, successMsg: string) => {
    const res = await fetch("/.netlify/functions/portal-action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, action, payload }),
    });
    const d = await res.json();
    if (d.success) {
      setActionMsg(successMsg);
      setTimeout(() => setActionMsg(null), 3000);
      // Refresh data
      fetch(`/.netlify/functions/portal-data?token=${token}`)
        .then(r => r.json()).then(nd => { if (!nd.error) setData(nd); });
    }
  };

  const sendMessage = async () => {
    if (!message.trim() || !activeProject) return;
    setSending(true);
    await doAction("send_message", { projectId: activeProject, message }, "Message sent!");
    setMessage("");
    setSending(false);
  };

  const color = data?.org.primaryColor ?? "#3B82F6";

  if (loading) return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="text-center space-y-3">
        <Loader2 className="h-8 w-8 animate-spin mx-auto text-blue-500" />
        <p className="text-sm text-gray-500">Loading your portal…</p>
      </div>
    </div>
  );

  if (error) return (
    <div className="flex h-screen items-center justify-center bg-gray-50">
      <div className="max-w-sm text-center space-y-4 px-6">
        <div className="h-16 w-16 mx-auto rounded-full bg-red-50 flex items-center justify-center">
          <AlertCircle className="h-8 w-8 text-red-500" />
        </div>
        <h1 className="text-xl font-semibold text-gray-900">Access Error</h1>
        <p className="text-sm text-gray-500">{error}</p>
      </div>
    </div>
  );

  if (!data) return null;

  const project = data.projects.find(p => p.id === activeProject);
  const projectEstimates = data.estimates.filter(e => project ? true : false);
  const projectInvoices  = data.invoices.filter(i => true);
  const projectNotes     = data.notes.filter(n => n.project_id === activeProject);
  const projectFiles     = data.files.filter(f => f.project_id === activeProject);

  const tabs: { id: string; label: string; icon: React.ReactNode; count?: number }[] = [
    { id: "overview",  label: "Overview",  icon: <Building2 className="h-4 w-4" /> },
    { id: "estimates", label: "Estimates", icon: <FileText className="h-4 w-4" />, count: data.estimates.length || undefined },
    { id: "invoices",  label: "Invoices",  icon: <CreditCard className="h-4 w-4" />, count: data.invoices.filter(i => i.status !== "paid").length || undefined },
    { id: "messages",  label: "Messages",  icon: <MessageSquare className="h-4 w-4" />, count: projectNotes.filter(n => !n.is_client_message).length || undefined },
    { id: "files",     label: "Files",     icon: <Download className="h-4 w-4" />, count: projectFiles.length || undefined },
  ];

  return (
    <div className="min-h-screen bg-gray-50 font-sans">
      {/* Action toast */}
      {actionMsg && (
        <div className="fixed top-4 right-4 z-50 flex items-center gap-2 rounded-lg bg-green-500 px-4 py-2.5 text-sm text-white shadow-lg animate-in fade-in slide-in-from-top-2">
          <CheckCircle2 className="h-4 w-4" />{actionMsg}
        </div>
      )}

      {/* Header */}
      <header className="bg-white border-b border-gray-100 sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            {data.org.logo
              ? <img src={data.org.logo} alt={data.org.name} className="h-8 w-auto object-contain" />
              : <div className="h-8 w-8 rounded-lg flex items-center justify-center text-white text-sm font-bold"
                  style={{ background: color }}>{data.org.name[0]}</div>}
            <div>
              <p className="text-sm font-semibold text-gray-900">{data.org.name}</p>
              {data.org.phone && <a href={`tel:${data.org.phone}`} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
                <Phone className="h-3 w-3" />{data.org.phone}
              </a>}
            </div>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-400">Logged in as</p>
            <p className="text-sm font-medium text-gray-700">{data.client.name}</p>
          </div>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-6 space-y-5">
        {/* Project selector */}
        {data.projects.length > 1 && (
          <div className="flex gap-2 overflow-x-auto pb-1">
            {data.projects.map(p => (
              <button key={p.id} onClick={() => setActiveProject(p.id)}
                className={`shrink-0 rounded-lg px-3 py-2 text-sm font-medium transition-all border ${
                  activeProject === p.id
                    ? "text-white border-transparent shadow-sm"
                    : "bg-white border-gray-200 text-gray-600 hover:border-gray-300"
                }`}
                style={activeProject === p.id ? { background: color, borderColor: color } : {}}>
                {p.name}
              </button>
            ))}
          </div>
        )}

        {data.projects.length === 0 && (
          <div className="rounded-xl bg-white border border-gray-100 p-8 text-center">
            <p className="text-gray-400 text-sm">No projects found for your account.</p>
          </div>
        )}

        {project && (
          <>
            {/* Project card */}
            <div className="rounded-xl bg-white border border-gray-100 overflow-hidden shadow-sm">
              <div className="px-5 py-4 border-b border-gray-50 flex items-start justify-between gap-4">
                <div>
                  <h1 className="text-lg font-semibold text-gray-900">{project.name}</h1>
                  {project.address && <p className="text-sm text-gray-400 mt-0.5">{project.address}</p>}
                  {project.description && <p className="text-sm text-gray-500 mt-1">{project.description}</p>}
                </div>
                <StatusBadge status={project.status} />
              </div>
              <div className="px-5 py-4 space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-500">Project progress</span>
                  <span className="font-semibold text-gray-900">{project.completion_percentage}%</span>
                </div>
                <ProgressBar pct={project.completion_percentage} color={color} />
                <div className="grid grid-cols-3 gap-4 pt-1">
                  <div>
                    <p className="text-[11px] text-gray-400 uppercase tracking-wide">Budget</p>
                    <p className="text-sm font-semibold text-gray-800">{fmtMoney(project.budget_total)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-gray-400 uppercase tracking-wide">Start</p>
                    <p className="text-sm font-semibold text-gray-800">{fmt(project.start_date)}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-gray-400 uppercase tracking-wide">Est. End</p>
                    <p className="text-sm font-semibold text-gray-800">{fmt(project.end_date)}</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-100 bg-white rounded-t-xl overflow-hidden shadow-sm">
              {tabs.map(tab => (
                <button key={tab.id} onClick={() => setActiveTab(tab.id as any)}
                  className={`flex-1 flex items-center justify-center gap-1.5 py-3 text-xs font-medium transition-all border-b-2 ${
                    activeTab === tab.id
                      ? "border-current"
                      : "border-transparent text-gray-400 hover:text-gray-600"
                  }`}
                  style={activeTab === tab.id ? { color, borderColor: color } : {}}>
                  {tab.icon}
                  <span className="hidden sm:inline">{tab.label}</span>
                  {tab.count ? <span className="ml-0.5 rounded-full bg-red-500 text-white text-[10px] h-4 min-w-4 flex items-center justify-center px-1">{tab.count}</span> : null}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="rounded-b-xl bg-white border border-t-0 border-gray-100 shadow-sm overflow-hidden">

              {/* Overview */}
              {activeTab === "overview" && (
                <div className="p-5 space-y-4">
                  {data.invoices.filter(i => i.status !== "paid").length > 0 && (
                    <div className="rounded-lg border border-amber-100 bg-amber-50 p-4">
                      <p className="text-sm font-medium text-amber-700 mb-1">Outstanding invoices</p>
                      {data.invoices.filter(i => i.status !== "paid").map(inv => (
                        <div key={inv.id} className="flex items-center justify-between">
                          <span className="text-sm text-amber-600">Invoice #{inv.invoice_number}</span>
                          <span className="text-sm font-semibold text-amber-800">{fmtMoney(inv.total_amount - inv.amount_paid)} due {fmt(inv.due_date)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {data.estimates.filter(e => e.status === "sent").length > 0 && (
                    <div className="rounded-lg border border-blue-100 bg-blue-50 p-4">
                      <p className="text-sm font-medium text-blue-700 mb-2">Awaiting your approval</p>
                      {data.estimates.filter(e => e.status === "sent").map(est => (
                        <div key={est.id} className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-sm font-medium text-blue-800">{est.title}</p>
                            <p className="text-xs text-blue-600">{fmtMoney(est.client_total ?? est.total)}</p>
                          </div>
                          <button onClick={() => doAction("approve_estimate", { estimateId: est.id }, "Estimate approved!")}
                            className="shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
                            style={{ background: color }}>
                            Approve
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="grid grid-cols-2 gap-3">
                    {[
                      { label: "Estimates", val: data.estimates.length, sub: `${data.estimates.filter(e => e.status === "accepted").length} approved` },
                      { label: "Invoices",  val: data.invoices.length,  sub: `${data.invoices.filter(i => i.status === "paid").length} paid` },
                      { label: "Messages",  val: projectNotes.length,   sub: "project updates" },
                      { label: "Files",     val: projectFiles.length,   sub: "documents" },
                    ].map(item => (
                      <div key={item.label} className="rounded-lg border border-gray-100 p-3">
                        <p className="text-2xl font-bold text-gray-900">{item.val}</p>
                        <p className="text-xs font-medium text-gray-600">{item.label}</p>
                        <p className="text-[11px] text-gray-400">{item.sub}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Estimates */}
              {activeTab === "estimates" && (
                <div className="divide-y divide-gray-50">
                  {data.estimates.length === 0 && <p className="text-sm text-gray-400 text-center py-10">No estimates yet.</p>}
                  {data.estimates.map(est => {
                    const isPending = est.status === "sent" && est.esign_status !== "signed";
                    return (
                      <div key={est.id} className="p-5">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              {est.number && <span className="text-xs text-gray-400">#{est.number}</span>}
                              <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${
                                est.status === "accepted" ? "bg-green-50 text-green-600"
                                  : est.status === "sent" ? "bg-blue-50 text-blue-600"
                                  : "bg-gray-50 text-gray-500"
                              }`}>{est.status}</span>
                            </div>
                            <p className="text-sm font-semibold text-gray-900 mt-1">{est.title}</p>
                            <p className="text-xs text-gray-400 mt-0.5">Sent {fmt(est.created_at)}{est.valid_until ? ` · Valid until ${fmt(est.valid_until)}` : ""}</p>
                          </div>
                          <div className="text-right shrink-0">
                            <p className="text-lg font-bold text-gray-900">{fmtMoney(est.client_total ?? est.total)}</p>
                            <div className="flex items-center gap-2 mt-2">
                              {est.pdf_url && (
                                <a href={est.pdf_url} target="_blank" rel="noopener noreferrer"
                                  className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
                                  <Download className="h-3 w-3" />PDF
                                </a>
                              )}
                              {isPending && (
                                <button onClick={() => doAction("approve_estimate", { estimateId: est.id }, "Estimate approved!")}
                                  className="rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
                                  style={{ background: color }}>
                                  Approve
                                </button>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Invoices */}
              {activeTab === "invoices" && (
                <div className="divide-y divide-gray-50">
                  {data.invoices.length === 0 && <p className="text-sm text-gray-400 text-center py-10">No invoices yet.</p>}
                  {data.invoices.map(inv => {
                    const balance = inv.total_amount - inv.amount_paid;
                    return (
                      <div key={inv.id} className="p-5 flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-gray-400">#{inv.invoice_number}</span>
                            <span className={`text-xs rounded-full px-2 py-0.5 font-medium ${
                              inv.status === "paid" ? "bg-green-50 text-green-600"
                                : inv.status === "overdue" ? "bg-red-50 text-red-600"
                                : "bg-amber-50 text-amber-600"
                            }`}>{inv.status}</span>
                          </div>
                          <p className="text-xs text-gray-400 mt-1">Issued {fmt(inv.issue_date)}{inv.due_date ? ` · Due ${fmt(inv.due_date)}` : ""}</p>
                          {inv.amount_paid > 0 && (
                            <p className="text-xs text-green-600 mt-0.5">{fmtMoney(inv.amount_paid)} paid</p>
                          )}
                        </div>
                        <div className="text-right shrink-0">
                          <p className="text-lg font-bold text-gray-900">{fmtMoney(inv.total_amount)}</p>
                          {balance > 0 && (
                            <>
                              <p className="text-xs text-gray-400">Balance: {fmtMoney(balance)}</p>
                              <button onClick={() => doAction("pay_invoice", { invoiceId: inv.id }, "Payment request sent!")}
                                className="mt-2 rounded-lg px-3 py-1.5 text-xs font-semibold text-white transition-opacity hover:opacity-90"
                                style={{ background: color }}>
                                Request Payment
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Messages */}
              {activeTab === "messages" && (
                <div className="flex flex-col h-120">
                  <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {projectNotes.length === 0 && (
                      <p className="text-sm text-gray-400 text-center py-6">No messages yet. Send a message below.</p>
                    )}
                    {projectNotes.map(note => (
                      <div key={note.id} className={`flex ${note.is_client_message ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 ${
                          note.is_client_message
                            ? "text-white rounded-br-sm"
                            : "bg-gray-100 text-gray-800 rounded-bl-sm"
                        }`} style={note.is_client_message ? { background: color } : {}}>
                          {!note.is_client_message && (
                            <p className="text-[10px] font-semibold opacity-60 mb-0.5">{note.author}</p>
                          )}
                          <p className="text-sm leading-relaxed">{note.body}</p>
                          <p className={`text-[10px] mt-1 ${note.is_client_message ? "text-white/60" : "text-gray-400"}`}>
                            {new Date(note.created_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
                          </p>
                        </div>
                      </div>
                    ))}
                    <div ref={messagesEndRef} />
                  </div>
                  <div className="border-t border-gray-100 p-3 flex gap-2">
                    <textarea
                      value={message}
                      onChange={e => setMessage(e.target.value)}
                      onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                      placeholder="Type a message…"
                      rows={1}
                      className="flex-1 resize-none rounded-xl border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:border-transparent"
                      style={{ focusRingColor: color } as any}
                    />
                    <button onClick={sendMessage} disabled={!message.trim() || sending}
                      className="rounded-xl px-3 flex items-center justify-center disabled:opacity-40 transition-opacity"
                      style={{ background: color }}>
                      {sending ? <Loader2 className="h-4 w-4 animate-spin text-white" /> : <Send className="h-4 w-4 text-white" />}
                    </button>
                  </div>
                </div>
              )}

              {/* Files */}
              {activeTab === "files" && (
                <div className="divide-y divide-gray-50">
                  {projectFiles.length === 0 && <p className="text-sm text-gray-400 text-center py-10">No files yet.</p>}
                  {projectFiles.map(file => (
                    <div key={file.id} className="flex items-center gap-3 p-4 hover:bg-gray-50 transition-colors">
                      <div className="h-9 w-9 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                        <FileText className="h-4 w-4 text-gray-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-800 truncate">{file.file_name}</p>
                        {file.description && <p className="text-xs text-gray-400 truncate">{file.description}</p>}
                        <p className="text-xs text-gray-400">{fmt(file.created_at)}</p>
                      </div>
                      <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
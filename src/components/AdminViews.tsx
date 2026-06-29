/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { db } from '../lib/firebase';
import { collection, onSnapshot, query, updateDoc, doc, addDoc, where, getDocs, writeBatch } from 'firebase/firestore';
import { useRouter } from '../lib/router';
import { Incident, UserProfile, IncidentEvent, IncidentStatus, PriorityLevel, Department } from '../types';
import { toast } from './Toast';
import { Shield, List, Sparkles, Files, CheckSquare, Settings, Users, ArrowUpRight, BarChart3, AlertCircle, HardHat, Droplet, Zap, Trash2, Check, X, Link, AlertTriangle } from 'lucide-react';
import { PriorityIndicator, StatusBadge } from './ui/CivicUI';

interface AdminViewsProps {
  user: UserProfile | null;
}

export default function AdminViews({ user }: AdminViewsProps) {
  const { navigate } = useRouter();
  
  // Tabs: DASHBOARD, TRIAGE, DUPLICATES, VERIFICATION, USERS
  const [activeTab, setActiveTab] = useState<'DASHBOARD' | 'TRIAGE' | 'DUPLICATES' | 'VERIFICATION' | 'USERS'>('DASHBOARD');

  // Shared state loaded from Firestore
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [users, setUsers] = useState<UserProfile[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [events, setEvents] = useState<IncidentEvent[]>([]);
  const [loading, setLoading] = useState(true);

  // Form states for Admin actions
  const [rejectionReason, setRejectionReason] = useState('');
  const [selectedIncidentId, setSelectedIncidentId] = useState<string | null>(null);

  // Routing and priority overrides for triage
  const [selectedDepts, setSelectedDepts] = useState<Record<string, string>>({});
  const [selectedPriorities, setSelectedPriorities] = useState<Record<string, PriorityLevel>>({});

  useEffect(() => {
    if (!user || user.role !== 'ADMIN') return;

    setLoading(true);
    
    // Subscribe to all Incidents
    const unsubInc = onSnapshot(query(collection(db, 'incidents')), (snap) => {
      const list: Incident[] = [];
      snap.forEach(d => {
        list.push({ id: d.id, ...d.data() } as Incident);
      });
      // Sort newest first by default
      list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setIncidents(list);
      setLoading(false);
    });

    // Subscribe to all Users
    const unsubUsers = onSnapshot(query(collection(db, 'users')), (snap) => {
      const list: UserProfile[] = [];
      snap.forEach(d => {
        list.push({ uid: d.id, ...d.data() } as UserProfile);
      });
      setUsers(list);
    });

    // Subscribe to all Departments
    const unsubDept = onSnapshot(query(collection(db, 'departments')), (snap) => {
      const list: Department[] = [];
      snap.forEach(d => {
        list.push({ id: d.id, ...d.data() } as Department);
      });
      setDepartments(list);
    });

    // Subscribe to all audit events (limit to recent 50)
    const unsubEvents = onSnapshot(query(collection(db, 'incidentEvents')), (snap) => {
      const list: IncidentEvent[] = [];
      snap.forEach(d => {
        list.push({ id: d.id, ...d.data() } as IncidentEvent);
      });
      list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      setEvents(list.slice(0, 50));
    });

    return () => {
      unsubInc();
      unsubUsers();
      unsubDept();
      unsubEvents();
    };
  }, [user]);

  // Handle Role updates for users
  const handleRoleUpdate = async (uid: string, newRole: string, deptId: string | null = null) => {
    try {
      toast('Updating user role and credentials...', 'info');
      const userRef = doc(db, 'users', uid);
      await updateDoc(userRef, {
        role: newRole,
        departmentId: deptId,
        updatedAt: new Date().toISOString()
      });
      toast('User role updated successfully!', 'success');
    } catch (err: any) {
      toast('Role modification failed: ' + err.message, 'error');
    }
  };

  // Admin Triage approval & routing reassign
  const handleTriageApproval = async (incId: string, approvedDeptId: string, approvedPriority: PriorityLevel) => {
    try {
      toast('Validating categorization and committing to repair queue...', 'info');
      const res = await fetch('/api/transition', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Uid': user?.uid || '',
          'X-User-Name': user?.name || '',
          'X-User-Role': user?.role || ''
        },
        body: JSON.stringify({
          incidentId: incId,
          action: 'ADMIN_ASSIGN',
          departmentId: approvedDeptId,
          priorityLevel: approvedPriority
        })
      });
      const data = await res.json();
      if (data.success) {
        toast('Incident assigned and dispatched successfully!', 'success');
      } else {
        toast('Dispatch failed: ' + data.error, 'error');
      }
    } catch (err: any) {
      toast('Dispatch failed: ' + err.message, 'error');
    }
  };

  // Rejection
  const handleRejectIncident = async (incId: string, reason: string) => {
    if (!reason.trim()) {
      toast('A rejection explanation reason is required.', 'warning');
      return;
    }

    try {
      toast('Logging rejection code...', 'info');
      const res = await fetch('/api/transition', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Uid': user?.uid || '',
          'X-User-Name': user?.name || '',
          'X-User-Role': user?.role || ''
        },
        body: JSON.stringify({
          incidentId: incId,
          action: 'ADMIN_REJECT',
          notes: reason
        })
      });
      const data = await res.json();
      if (data.success) {
        toast('Case successfully rejected and locked.', 'success');
        setRejectionReason('');
        setSelectedIncidentId(null);
      } else {
        toast('Rejection failed: ' + data.error, 'error');
      }
    } catch (err: any) {
      toast('Rejection failed: ' + err.message, 'error');
    }
  };

  // Resolution approval verification
  const handleResolveVerify = async (incId: string, approved: boolean, reason: string) => {
    try {
      if (approved) {
        toast('Committing final resolution signature...', 'info');
        const res = await fetch('/api/transition', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Uid': user?.uid || '',
            'X-User-Name': user?.name || '',
            'X-User-Role': user?.role || ''
          },
          body: JSON.stringify({
            incidentId: incId,
            action: 'ADMIN_VERIFY_RESOLVE'
          })
        });
        const data = await res.json();
        if (data.success) {
          toast('Incident ticket resolved and closed!', 'success');
        } else {
          toast('Verification failed: ' + data.error, 'error');
        }
      } else {
        toast('Returning case to department repairs team...', 'info');
        const res = await fetch('/api/transition', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Uid': user?.uid || '',
            'X-User-Name': user?.name || '',
            'X-User-Role': user?.role || ''
          },
          body: JSON.stringify({
            incidentId: incId,
            action: 'ADMIN_VERIFY_RETURN',
            notes: reason
          })
        });
        const data = await res.json();
        if (data.success) {
          toast('Case returned with comments.', 'success');
        } else {
          toast('Verification return failed: ' + data.error, 'error');
        }
      }
    } catch (err: any) {
      toast('Verification transaction failed: ' + err.message, 'error');
    }
  };

  // Duplicates Merger logic
  const handleMergeDuplicate = async (masterId: string, duplicateId: string) => {
    try {
      toast('Merging reports and consolidating indicators...', 'info');
      const res = await fetch('/api/transition', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Uid': user?.uid || '',
          'X-User-Name': user?.name || '',
          'X-User-Role': user?.role || ''
        },
        body: JSON.stringify({
          incidentId: duplicateId,
          action: 'ADMIN_MERGE_DUPLICATE',
          masterIncidentId: masterId
        })
      });
      const data = await res.json();
      if (data.success) {
        toast('Consolidated successfully!', 'success');
      } else {
        toast('Merge failed: ' + data.error, 'error');
      }
    } catch (err: any) {
      toast('Merge failed: ' + err.message, 'error');
    }
  };

  if (!user || user.role !== 'ADMIN') {
    return (
      <div className="max-w-md mx-auto my-12 text-center p-8 bg-white rounded-2xl border border-slate-200 shadow-sm">
        <AlertTriangle className="w-10 h-10 text-rose-500 mx-auto mb-3" />
        <h4 className="font-extrabold text-slate-800 text-sm">Access Denied</h4>
        <p className="text-xs text-slate-500 mt-1">You must be logged in as an Administrator to view this secure portal.</p>
      </div>
    );
  }

  // Filter queues
  const triageQueue = incidents.filter(i => i.status === 'SUBMITTED' || i.status === 'AI_TRIAGED' || i.status === 'PENDING_ADMIN_REVIEW' || i.status === 'REOPENED');
  const verificationQueue = incidents.filter(i => i.status === 'RESOLUTION_EVIDENCE_SUBMITTED' || i.status === 'PENDING_ADMIN_VERIFICATION');
  
  // Find potential duplicates: incidents within same category and close proximity
  const getDuplicateGroups = () => {
    const groups: { master: Incident; candidates: Incident[] }[] = [];
    const openIncs = incidents.filter(i => i.status !== 'RESOLVED' && i.status !== 'REJECTED' && i.status !== 'DUPLICATE_MERGED');
    
    openIncs.forEach(master => {
      const candidates = openIncs.filter(cand => 
        cand.id !== master.id && 
        cand.category === master.category &&
        Math.abs(cand.location.latitude - master.location.latitude) < 0.01 &&
        Math.abs(cand.location.longitude - master.location.longitude) < 0.01
      );
      if (candidates.length > 0 && !groups.some(g => g.master.category === master.category && g.master.id === candId(g.candidates, master.id))) {
        groups.push({ master, candidates });
      }
    });
    return groups;
  };

  const candId = (arr: Incident[], id: string) => arr.find(item => item.id === id)?.id;

  return (
    <div id="admin-workspace-portal" className="civic-page space-y-8">
      {/* Portal Header */}
      <header className="civic-page-header">
        <div>
          <p className="civic-eyebrow">Municipal administrator</p>
          <h1 className="civic-title flex items-center gap-2">
            <Shield className="w-6.5 h-6.5 text-[#174f78]" /> Decision desk
          </h1>
          <p className="civic-subtitle">
            Dispatch, route, verify, and govern the municipal workflow ledger of Veridale.
          </p>
        </div>

        {/* Workspace Nav Tabs */}
        <div className="flex max-w-full flex-wrap gap-1 rounded-lg border border-slate-200 bg-slate-100 p-1" role="tablist" aria-label="Administrator workspace sections">
          {(['DASHBOARD', 'TRIAGE', 'DUPLICATES', 'VERIFICATION', 'USERS'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              role="tab"
              aria-selected={activeTab === tab}
              className={`min-h-10 rounded-md px-3 py-2 text-[10px] font-bold uppercase tracking-wider transition-colors sm:text-xs ${
                activeTab === tab
                  ? 'bg-[#174f78] text-white shadow-sm'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              {tab === 'TRIAGE' && `Triage (${triageQueue.length})`}
              {tab === 'VERIFICATION' && `Verification (${verificationQueue.length})`}
              {tab !== 'TRIAGE' && tab !== 'VERIFICATION' && tab}
            </button>
          ))}
        </div>
      </header>

      {loading ? (
        <div className="flex justify-center items-center py-20">
          <div className="w-10 h-10 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
        </div>
      ) : (
        <>
          {/* TAB: DASHBOARD */}
          {activeTab === 'DASHBOARD' && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 text-left">
              <div className="lg:col-span-2 space-y-6">
                <h3 className="font-sans font-extrabold text-base text-slate-950">
                  Veridale Workspace Stats
                </h3>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                  <div className="civic-panel border-t-[3px] border-t-slate-500 p-4">
                    <span className="text-[9px] font-bold text-slate-400 uppercase tracking-wider block">Total Incidents</span>
                    <span className="civic-number mt-1 block text-2xl font-extrabold text-slate-900">{incidents.length}</span>
                  </div>
                  <div className="civic-panel border-t-[3px] border-t-rose-700 p-4">
                    <span className="text-[9px] font-bold text-rose-500 uppercase tracking-wider block">Critical</span>
                    <span className="text-2xl font-extrabold text-rose-600 block mt-1">
                      {incidents.filter(i => i.priorityLevel === 'CRITICAL' && i.status !== 'RESOLVED').length}
                    </span>
                  </div>
                  <div className="civic-panel border-t-[3px] border-t-[#174f78] p-4">
                    <span className="text-[9px] font-bold text-blue-500 uppercase tracking-wider block">Triage Queue</span>
                    <span className="text-2xl font-extrabold text-blue-600 block mt-1">{triageQueue.length}</span>
                  </div>
                  <div className="civic-panel border-t-[3px] border-t-emerald-700 p-4">
                    <span className="text-[9px] font-bold text-emerald-600 uppercase tracking-wider block">Resolved</span>
                    <span className="text-2xl font-extrabold text-emerald-600 block mt-1">
                      {incidents.filter(i => i.status === 'RESOLVED').length}
                    </span>
                  </div>
                </div>

                {/* Open issues list */}
                <section className="civic-panel space-y-4 p-5" aria-labelledby="recent-incidents-heading">
                  <h4 className="font-sans font-bold text-sm text-slate-950 flex items-center justify-between">
                    <span id="recent-incidents-heading">Recent incident ledger</span>
                    <button onClick={() => navigate('/community-map')} className="text-[10px] text-indigo-600 font-bold hover:underline inline-flex items-center gap-1">
                      View Live Map <ArrowUpRight className="w-3.5 h-3.5" />
                    </button>
                  </h4>

                  <div className="divide-y divide-slate-100 max-h-[400px] overflow-y-auto pr-1">
                    {incidents.slice(0, 10).map(inc => (
                      <button
                        type="button"
                        key={inc.id}
                        onClick={() => navigate(`/incident/${inc.id}`)}
                        className="flex w-full items-center justify-between rounded-lg px-2 py-3 text-left transition-colors hover:bg-slate-50"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] font-mono text-slate-400 font-bold">{inc.incidentCode}</span>
                            <PriorityIndicator level={inc.priorityLevel} />
                          </div>
                          <p className="text-xs font-bold text-slate-800 truncate mt-0.5">{inc.title}</p>
                        </div>

                        <StatusBadge status={inc.status} />
                      </button>
                    ))}
                  </div>
                </section>
              </div>

              {/* Audit logs timeline */}
              <section className="civic-panel space-y-4 p-5" aria-labelledby="global-audit-heading">
                <h4 className="font-sans font-bold text-sm text-slate-950">
                  <span id="global-audit-heading">Global audit ledger</span>
                </h4>

                <div className="space-y-4 max-h-[500px] overflow-y-auto pr-1">
                  {events.map((evt, i) => (
                    <div key={evt.id || i} className="text-xs space-y-1 pb-3 border-b border-slate-50">
                      <p className="font-semibold text-slate-800 leading-normal">{evt.message}</p>
                      <div className="flex items-center justify-between text-[9px] text-slate-400 font-mono font-bold uppercase">
                        <span>{evt.actorName} ({evt.actorRole})</span>
                        <span>{new Date(evt.createdAt).toLocaleDateString()}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}

          {/* TAB: TRIAGE */}
          {activeTab === 'TRIAGE' && (
            <div className="space-y-6 text-left max-w-5xl mx-auto">
              <div>
                <h3 className="font-sans font-extrabold text-lg text-slate-950">
                  Administrative Triage Inbox ({triageQueue.length})
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Review raw citizen report evidence and AI predictions, verify priority, and dispatch to appropriate teams.
                </p>
              </div>

              {triageQueue.length === 0 ? (
                <div className="text-center py-12 bg-white rounded-xl border border-slate-200">
                  <p className="text-xs text-slate-500 font-medium">Triage queue is empty. Good work!</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {triageQueue.map(inc => (
                    <article
                      key={inc.id}
                      className="civic-panel grid grid-cols-1 overflow-hidden md:grid-cols-5"
                    >
                      {/* Image column */}
                      <div className="md:col-span-2 relative h-48 md:h-full bg-slate-100">
                        {inc.primaryImageUrl && (
                          <img
                            src={inc.primaryImageUrl}
                            alt={`Citizen evidence for ${inc.title}`}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover"
                          />
                        )}
                        <span className="absolute top-3 left-3 bg-slate-900/90 text-white font-mono font-bold text-[10px] px-2 py-0.5 rounded-md">
                          {inc.incidentCode}
                        </span>
                      </div>

                      {/* Content column */}
                      <div className="p-5 md:col-span-3 space-y-4 flex flex-col justify-between">
                        <div className="space-y-2">
                          <h4 className="text-sm font-bold text-slate-900 leading-snug">{inc.title}</h4>
                          <p className="text-xs text-slate-600 line-clamp-3 leading-normal">
                            "{inc.aiAnalysis.explanation}"
                          </p>

                          {/* AI recommendations */}
                          <div className="civic-ai-panel flex items-start gap-2 p-3 text-indigo-950">
                            <Sparkles className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                            <div className="min-w-0 text-xs">
                              <span className="font-bold">AI Routing Suggestion:</span> Route to <span className="font-extrabold uppercase">{inc.aiAnalysis.categoryRecommendation}</span> (Dept: {inc.aiAnalysis.recommendedDepartmentId}) with <span className="font-extrabold text-rose-700">{inc.aiAnalysis.urgencyLevel}</span> priority.
                            </div>
                          </div>
                        </div>

                        {/* Dispatch Override Settings */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 bg-slate-50 p-4 rounded-xl border border-slate-200/60 text-left">
                          <div className="space-y-1.5">
                            <label htmlFor={`dept-assign-${inc.id}`} className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block font-mono">
                              Dispatch Department
                            </label>
                            <select
                              id={`dept-assign-${inc.id}`}
                              value={selectedDepts[inc.id] || inc.aiAnalysis.recommendedDepartmentId || 'general'}
                              onChange={(e) => setSelectedDepts(prev => ({ ...prev, [inc.id]: e.target.value }))}
                              className="w-full border border-slate-200 focus:outline-none focus:border-[#174f78] p-2 text-xs rounded-xl bg-white font-sans text-slate-700 font-medium"
                            >
                              <option value="roads">Roads & Maintenance</option>
                              <option value="electrical">Electrical Services</option>
                              <option value="water">Water Services</option>
                              <option value="sanitation">Sanitation Department</option>
                              <option value="general">General Administration</option>
                            </select>
                          </div>

                          <div className="space-y-1.5">
                            <label htmlFor={`priority-assign-${inc.id}`} className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block font-mono">
                              Verify Urgency
                            </label>
                            <select
                              id={`priority-assign-${inc.id}`}
                              value={selectedPriorities[inc.id] || inc.aiAnalysis.urgencyLevel || 'MEDIUM'}
                              onChange={(e) => setSelectedPriorities(prev => ({ ...prev, [inc.id]: e.target.value as PriorityLevel }))}
                              className="w-full border border-slate-200 focus:outline-none focus:border-[#174f78] p-2 text-xs rounded-xl bg-white font-sans text-slate-700 font-medium"
                            >
                              <option value="LOW">Low Urgency</option>
                              <option value="MEDIUM">Medium Urgency</option>
                              <option value="HIGH">High Urgency</option>
                              <option value="CRITICAL">Critical Urgency</option>
                            </select>
                          </div>
                        </div>

                        {/* Actions block */}
                        <div className="civic-action-bar">
                          <button
                            onClick={() => {
                              setSelectedIncidentId(inc.id);
                              setRejectionReason('');
                            }}
                            className="px-3 py-1.5 border border-slate-200 text-rose-600 hover:bg-rose-50 rounded-xl text-xs font-bold transition-all"
                          >
                            Reject
                          </button>

                          <button
                            onClick={() => {
                              const dept = selectedDepts[inc.id] || inc.aiAnalysis.recommendedDepartmentId || 'general';
                              const prio = selectedPriorities[inc.id] || inc.aiAnalysis.urgencyLevel || 'MEDIUM';
                              handleTriageApproval(inc.id, dept, prio);
                            }}
                            className="civic-primary-button flex items-center gap-1 px-4 text-xs font-bold"
                          >
                            <Check className="w-4 h-4" /> Approve & Dispatch
                          </button>
                        </div>

                        {/* Rejection popup drawer overlay */}
                        {selectedIncidentId === inc.id && (
                          <div className="mt-4 p-4 bg-rose-50 border border-rose-100 rounded-xl space-y-3">
                            <label htmlFor={`admin-rejection-${inc.id}`} className="text-xs font-bold text-rose-800 block">Rejection Reason</label>
                            <input
                              id={`admin-rejection-${inc.id}`}
                              type="text"
                              value={rejectionReason}
                              onChange={(e) => setRejectionReason(e.target.value)}
                              className="w-full border border-rose-200 focus:outline-none focus:border-rose-400 p-2 text-xs rounded-lg"
                              placeholder="Please explain why this report is rejected..."
                              required
                            />
                            <div className="flex justify-end gap-2">
                              <button
                                onClick={() => setSelectedIncidentId(null)}
                                className="px-2.5 py-1 text-xs text-slate-500 font-semibold"
                              >
                                Cancel
                              </button>
                              <button
                                onClick={() => handleRejectIncident(inc.id, rejectionReason)}
                                className="px-3 py-1 bg-rose-600 text-white font-bold text-xs rounded-lg hover:bg-rose-700"
                              >
                                Confirm Rejection
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB: DUPLICATES */}
          {activeTab === 'DUPLICATES' && (
            <div className="space-y-6 text-left max-w-4xl mx-auto">
              <div>
                <h3 className="font-sans font-extrabold text-lg text-slate-950">
                  Duplicate Candidate Reviews
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  AI scans geospatial grids and matches categories to cluster duplicate incident reports.
                </p>
              </div>

              {getDuplicateGroups().length === 0 ? (
                <div className="text-center py-12 bg-white rounded-xl border border-slate-200">
                  <p className="text-xs text-slate-500 font-medium">No active duplicate candidates identified in Veridale grid.</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {getDuplicateGroups().map((group, idx) => (
                    <div key={idx} className="civic-panel space-y-4 p-5">
                      <div className="flex items-center gap-2">
                        <Files className="w-5 h-5 text-indigo-600" />
                        <h4 className="text-sm font-bold text-slate-900">
                          Consolidation Group: {group.master.category} ({group.candidates.length + 1} Reports)
                        </h4>
                      </div>

                      {/* Side by side comparison cards */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {/* Master Record */}
                        <div className="p-4 bg-slate-50 rounded-xl border border-slate-200 text-left">
                          <span className="text-[9px] font-bold text-emerald-600 bg-emerald-50 border border-emerald-200 px-2 py-0.5 rounded-full uppercase">
                            Master Ticket
                          </span>
                          <h5 className="font-bold text-slate-900 text-xs mt-2">{group.master.incidentCode}: {group.master.title}</h5>
                          <p className="text-xs text-slate-500 mt-1">{group.master.location.displayAddress}</p>
                        </div>

                        {/* Candidate Duplicates */}
                        <div className="space-y-3">
                          {group.candidates.map(cand => (
                            <div key={cand.id} className="p-4 bg-rose-50/40 rounded-xl border border-rose-100 text-left flex flex-col justify-between">
                              <div>
                                <span className="text-[9px] font-bold text-rose-600 bg-rose-50 border border-rose-200 px-2 py-0.5 rounded-full uppercase">
                                  Duplicate Candidate
                                </span>
                                <h5 className="font-bold text-slate-900 text-xs mt-2">{cand.incidentCode}: {cand.title}</h5>
                                <p className="text-xs text-slate-500 mt-1">{cand.location.displayAddress}</p>
                              </div>

                              <button
                                onClick={() => handleMergeDuplicate(group.master.id, cand.id)}
                                className="mt-4 px-3 py-1.5 bg-slate-900 text-white rounded-lg text-xs font-bold hover:bg-indigo-600 transition-all inline-flex items-center justify-center gap-1.5 w-full"
                              >
                                <Link className="w-3.5 h-3.5" /> Merge Into Master
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB: VERIFICATION */}
          {activeTab === 'VERIFICATION' && (
            <div className="space-y-6 text-left max-w-4xl mx-auto">
              <div>
                <h3 className="font-sans font-extrabold text-lg text-slate-950">
                  Resolution Verification Queue ({verificationQueue.length})
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Inspect side-by-side original evidence and department-uploaded resolution repair photos before closing cases.
                </p>
              </div>

              {verificationQueue.length === 0 ? (
                <div className="text-center py-12 bg-white rounded-xl border border-slate-200">
                  <p className="text-xs text-slate-500 font-medium">All resolution requests have been cleared.</p>
                </div>
              ) : (
                <div className="space-y-6">
                  {verificationQueue.map(inc => (
                    <div key={inc.id} className="civic-panel space-y-4 p-5">
                      <div className="flex justify-between items-start flex-wrap gap-2">
                        <div>
                          <h4 className="font-bold text-slate-900 text-sm">{inc.incidentCode}: {inc.title}</h4>
                          <p className="text-xs text-slate-500 mt-0.5">{inc.location.displayAddress} | Dept: {inc.assignedDepartmentName}</p>
                        </div>
                        <StatusBadge status={inc.status} />
                      </div>

                      {/* Side by side Image comparison */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div className="space-y-2">
                          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block font-mono">Original citizen report photo</p>
                          <img
                            src={inc.primaryImageUrl || 'https://images.unsplash.com/photo-1515162305285-0293e4767cc2?auto=format&fit=crop&w=600&q=80'}
                            alt={`Original citizen evidence for ${inc.title}`}
                            referrerPolicy="no-referrer"
                            className="w-full h-48 object-cover rounded-xl border border-slate-200"
                          />
                        </div>
                        <div className="space-y-2">
                          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-wider block font-mono">Department repair evidence photo</p>
                          <img
                            src={inc.resolutionEvidenceUrl || 'https://images.unsplash.com/photo-1509023464722-18d996393ca8?auto=format&fit=crop&w=600&q=80'}
                            alt={`Department repair evidence for ${inc.title}`}
                            referrerPolicy="no-referrer"
                            className="w-full h-48 object-cover rounded-xl border border-slate-200 bg-slate-50"
                          />
                        </div>
                      </div>

                      {/* Approval triggers */}
                      <div className="civic-action-bar">
                        <button
                          onClick={() => handleResolveVerify(inc.id, false, 'Evidence photograph is discolored or incomplete')}
                          className="px-3.5 py-1.5 border border-slate-200 hover:bg-rose-50 text-rose-600 font-bold text-xs rounded-xl transition"
                        >
                          Reject & Reopen
                        </button>
                        <button
                          onClick={() => handleResolveVerify(inc.id, true, '')}
                          className="civic-primary-button flex items-center gap-1.5 px-4 text-xs"
                        >
                          <Check className="w-4 h-4" /> Approve & Close Case
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB: USERS */}
          {activeTab === 'USERS' && (
            <div className="space-y-6 text-left max-w-5xl mx-auto">
              <div>
                <h3 className="font-sans font-extrabold text-lg text-slate-950">
                  Secure Role Access Management
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  Reconfigure workspace profiles, escalate role authorization permissions, and sync department managers dynamically.
                </p>
              </div>

              <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
                <table className="w-full text-xs text-left">
                  <thead className="bg-slate-50 text-slate-400 uppercase font-mono font-bold border-b border-slate-200">
                    <tr>
                      <th className="px-6 py-3">Profile Name</th>
                      <th className="px-6 py-3">Email Account</th>
                      <th className="px-6 py-3">Active Role</th>
                      <th className="px-6 py-3">Department Binding</th>
                      <th className="px-6 py-3 text-right">Escalate Access</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 font-sans">
                    {users.map(u => (
                      <tr key={u.uid} className="hover:bg-slate-50/50">
                        <td className="px-6 py-4 font-bold text-slate-900">{u.name}</td>
                        <td className="px-6 py-4 font-mono text-slate-500">{u.email}</td>
                        <td className="px-6 py-4">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            u.role === 'ADMIN' ? 'bg-rose-50 text-rose-700' :
                            u.role === 'DEPARTMENT_MANAGER' ? 'bg-amber-50 text-amber-700' :
                            'bg-slate-100 text-slate-600'
                          }`}>
                            {u.role}
                          </span>
                        </td>
                        <td className="px-6 py-4 font-mono uppercase text-slate-500">
                          {u.departmentId || 'None'}
                        </td>
                        <td className="px-6 py-4 text-right">
                          <select
                            aria-label={`Change role for ${u.name}`}
                            value={u.role}
                            onChange={(e) => {
                              const r = e.target.value;
                              let d: string | null = null;
                              if (r === 'DEPARTMENT_MANAGER') {
                                d = prompt('Assign department ID (roads, water, electrical, sanitation, general):', 'roads');
                                if (d) d = d.trim().toLowerCase();
                              }
                              handleRoleUpdate(u.uid, r, d);
                            }}
                            className="border border-slate-200 focus:outline-none focus:border-indigo-500 p-1 rounded-lg text-xs"
                          >
                            <option value="CITIZEN">Citizen</option>
                            <option value="ADMIN">Admin</option>
                            <option value="DEPARTMENT_MANAGER">Dept Manager</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { useRouter } from '../lib/router';
import { db } from '../lib/firebase';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { UserProfile, Incident } from '../types';
import { Clock, ChevronRight, AlertTriangle, HelpCircle, Plus } from 'lucide-react';
import { EmptyState, PageHeader, PriorityIndicator, StatusBadge } from './ui/CivicUI';

interface MyReportsProps {
  user: UserProfile | null;
}

export default function MyReports({ user }: MyReportsProps) {
  const { navigate } = useRouter();
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user) return;

    let unsubscribeInc: (() => void) | null = null;

    // Load incidents where either creator matches or we fetch all reports and cross reference.
    // To keep it clean and performant, we can subscribe to all reports for reporterId, then fetch their matching incidents.
    // Or we can load all incidents and filter client-side, or query 'reports' collection first.
    // Let's query reports first for reporterId! This is extremely efficient and matches the data structure perfectly.
    const reportsQuery = query(collection(db, 'reports'), where('reporterId', '==', user.uid));
    
    const unsubscribeReports = onSnapshot(reportsQuery, (reportsSnap) => {
      const incidentIds: string[] = [];
      reportsSnap.forEach(docSnap => {
        const rep = docSnap.data();
        if (rep.incidentId) {
          incidentIds.push(rep.incidentId);
        }
      });

      if (unsubscribeInc) {
        unsubscribeInc();
        unsubscribeInc = null;
      }

      if (incidentIds.length === 0) {
        setIncidents([]);
        setLoading(false);
        return;
      }

      // Query incidents containing these IDs
      // Firestore 'in' query has 10 limit, so let's fetch all incidents and filter in memory, or query dynamically.
      // Fetching all incidents is very robust for a hackathon sandbox.
      const incQuery = query(collection(db, 'incidents'));
      unsubscribeInc = onSnapshot(incQuery, (incSnap) => {
        const list: Incident[] = [];
        incSnap.forEach(docSnap => {
          const inc = { id: docSnap.id, ...docSnap.data() } as Incident;
          if (incidentIds.includes(inc.id)) {
            list.push(inc);
          }
        });
        setIncidents(list);
        setLoading(false);
      });
    }, (error) => {
      console.error('[CivicResolve MyReports] Error loading reports:', error);
      setLoading(false);
    });

    return () => {
      unsubscribeReports();
      if (unsubscribeInc) {
        unsubscribeInc();
      }
    };
  }, [user]);

  if (!user) {
    return (
      <div className="max-w-md mx-auto my-12 text-center p-6 bg-white rounded-2xl border border-slate-200 shadow-sm">
        <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto mb-3" />
        <h4 className="font-bold text-slate-800">Authentication Required</h4>
        <p className="text-xs text-slate-500 mt-1">Please login to view your personal citizen incident dashboard.</p>
        <button
          onClick={() => navigate('/login')}
          className="mt-4 px-4 py-2 bg-slate-900 text-white font-bold text-xs rounded-xl hover:bg-slate-800 transition"
        >
          Login
        </button>
      </div>
    );
  }

  return (
    <div id="my-reports-page" className="civic-page-narrow space-y-6">
      <PageHeader
        eyebrow="Citizen workspace"
        title="My reported incidents"
        description="Track current ownership, repair progress, evidence, and the audit history for every case you submitted."
        actions={(
          <button type="button" onClick={() => navigate('/report')} className="civic-primary-button flex items-center gap-2 px-4 text-xs">
            <Plus className="h-4 w-4" aria-hidden="true" /> Report issue
          </button>
        )}
      />

      {loading ? (
        <div className="flex justify-center items-center py-12">
          <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
        </div>
      ) : incidents.length === 0 ? (
        <EmptyState
          icon={<Clock className="h-5 w-5" aria-hidden="true" />}
          title="No incidents reported yet"
          description="Your account has no submitted cases. Use Report issue when you need to notify the city about a municipal problem."
        />
      ) : (
        <div className="space-y-3" aria-label="Your reported incidents">
          {incidents.map(inc => (
            <button
              type="button"
              key={inc.id}
              onClick={() => navigate(`/incident/${inc.id}`)}
              className="civic-panel flex w-full flex-col items-start justify-between gap-4 p-4 text-left transition-colors hover:border-[#8aa9bd] hover:bg-slate-50 sm:flex-row sm:items-center"
            >
              <div className="flex gap-3.5 items-center min-w-0">
                {inc.primaryImageUrl ? (
                  <img
                    src={inc.primaryImageUrl}
                    alt={`Evidence for ${inc.title}`}
                    referrerPolicy="no-referrer"
                    className="w-14 h-14 rounded-xl object-cover shrink-0"
                  />
                ) : (
                  <div className="w-14 h-14 bg-slate-100 rounded-xl flex items-center justify-center text-slate-400 shrink-0">
                    <HelpCircle className="w-6 h-6" />
                  </div>
                )}
                <div className="min-w-0 text-left">
                  <div className="flex items-center gap-2">
                    <span className="civic-tabular text-xs font-bold text-slate-500">{inc.incidentCode}</span>
                    <StatusBadge status={inc.status} />
                  </div>
                  <h4 className="text-sm font-bold text-slate-900 truncate mt-1 leading-snug">{inc.title}</h4>
                  <p className="text-xs text-slate-500 truncate leading-tight mt-0.5">{inc.location.displayAddress}</p>
                  <p className="mt-2 text-[11px] text-slate-500">
                    {inc.category.replace(/_/g, ' ')} · {inc.assignedDepartmentName || 'Awaiting department'} · Submitted {new Date(inc.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </div>

              <div className="flex items-center justify-between sm:justify-end gap-4 w-full sm:w-auto border-t sm:border-t-0 pt-3 sm:pt-0 mt-2 sm:mt-0">
                <PriorityIndicator level={inc.priorityLevel} score={inc.priorityScore} />
                <div className="p-2 bg-slate-50 hover:bg-slate-100 rounded-xl transition-all">
                  <ChevronRight className="w-4 h-4 text-slate-400" />
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import { adminMock as admin, getFirestoreMock as getFirestore, readDb, writeDb } from './server/adminMock';
import { analyzeIncidentReport } from './server/geminiService';
import { calculatePriorityScore } from './src/lib/scoring';
import { evaluateDuplicateCandidate, getDistanceInMeters } from './src/lib/duplicates';
import { DEPARTMENTS_SEED, USERS_SEED, INCIDENTS_SEED, REPORTS_SEED, EVENTS_SEED } from './server/seedData';

const projectId = 'gen-lang-client-0945812895';
const databaseId = 'ai-studio-b0dad04a-6f52-4710-8c47-37560af0d7e8';

const appInstance = admin.initializeApp();
const db = getFirestore();

// Helper to authenticate user via Token or custom developer headers
async function authenticateRequest(req: express.Request): Promise<{ uid: string; name: string; role: string; departmentId?: string | null }> {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      const decoded = await (admin as any).auth().verifyIdToken(token);
      
      // Look up user role from Firestore
      const userDoc = await db.collection('users').doc(decoded.uid).get();
      if (userDoc.exists) {
        const u = userDoc.data();
        return {
          uid: decoded.uid,
          name: u?.name || decoded.name || 'Anonymous User',
          role: u?.role || 'CITIZEN',
          departmentId: u?.departmentId || null
        };
      }
      return {
        uid: decoded.uid,
        name: decoded.name || 'Anonymous User',
        role: 'CITIZEN',
        departmentId: null
      };
    } catch (tokenErr) {
      console.warn('[CivicResolve Server] Token verification failed, trying headers fallback:', tokenErr);
    }
  }

  // Developer / Sandboxed Preview Fallback Headers
  const fallbackUid = req.headers['x-user-uid'] as string;
  const fallbackName = req.headers['x-user-name'] as string;
  const fallbackRole = req.headers['x-user-role'] as string;
  const fallbackDept = req.headers['x-user-deptid'] as string;

  if (fallbackUid) {
    return {
      uid: fallbackUid,
      name: fallbackName || 'Anonymous Sandbox User',
      role: fallbackRole || 'CITIZEN',
      departmentId: fallbackDept || null
    };
  }

  throw new Error('Unauthorized: No valid credentials provided.');
}

const app = express();
const isProduction = process.env.NODE_ENV === 'production';
const demoApiEnabled = !isProduction || process.env.ALLOW_INSECURE_DEMO_API === 'true';

// Base64 image previews can be ~33% larger than the selected file and the
// mock batch stores the URL in both report and incident documents.
// This safely accommodates the report form's existing 10 MB image limit.
app.use(express.json({ limit: '30mb' }));

// This project intentionally uses a local, file-backed Firebase simulation.
// Keep development frictionless, but prevent accidental public production use.
app.use(['/api/mock-db', '/api/mock-auth', '/api/seed', '/api/transition'], (req, res, next) => {
  if (!demoApiEnabled) {
    return res.status(503).json({
      error: 'The local demo API is disabled in production. Set ALLOW_INSECURE_DEMO_API=true only for an intentional demo deployment.'
    });
  }
  return next();
});

  // Global Mock Database State Endpoint (for unified single-request client sync)
  app.get('/api/mock-db/all', (req, res) => {
    try {
      const dbData = readDb();
      // Strip large media collection to keep payload size extremely small
      const { media, ...cleanDbData } = dbData;
      return res.json({ success: true, db: cleanDbData });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // GET Media endpoint (decodes base64 content and serves directly)
  app.get('/api/media/:mediaId', (req, res) => {
    try {
      const dbData = readDb();
      const mediaItem = dbData.media?.[req.params.mediaId];
      if (!mediaItem) {
        return res.status(404).send('Media Not Found');
      }

      const match = mediaItem.match(/^data:(image\/[a-zA-Z+-]+);base64,(.+)$/);
      if (match) {
        const contentType = match[1];
        const base64Data = match[2];
        const imgBuffer = Buffer.from(base64Data, 'base64');
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': imgBuffer.length,
          'Cache-Control': 'public, max-age=31536000'
        });
        return res.end(imgBuffer);
      } else {
        return res.status(400).send('Invalid media format');
      }
    } catch (e: any) {
      return res.status(500).send(e.message);
    }
  });

  // POST Upload Media endpoint
  app.post('/api/media/upload', (req, res) => {
    try {
      const { base64 } = req.body;
      if (!base64) {
        return res.status(400).json({ error: 'Base64 data is required.' });
      }

      const dbData = readDb();
      if (!dbData.media) {
        dbData.media = {};
      }

      const mediaId = 'med-' + Math.random().toString(36).substring(2, 9);
      dbData.media[mediaId] = base64;
      writeDb(dbData);

      console.log(`[CivicResolve Media] Image uploaded successfully. Saved with ID: ${mediaId}`);
      return res.json({ success: true, url: `/api/media/${mediaId}` });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // Local Mock Database Endpoint
  app.post('/api/mock-db', (req, res) => {
    try {
      const { action, collectionName, docId, data, options, constraints, operations } = req.body;
      const dbData = readDb();

      if (action === 'getDoc') {
        const col = dbData[collectionName] || {};
        const doc = col[docId] || null;
        return res.json({ success: true, data: doc });
      }

      if (action === 'getDocs') {
        const col = dbData[collectionName] || {};
        let docs = Object.values(col);

        // Apply where constraints if any
        if (constraints && Array.isArray(constraints)) {
          for (const con of constraints) {
            if (con.type === 'where') {
              const { field, operator, value } = con;
              docs = docs.filter((doc: any) => {
                const val = doc[field];
                if (operator === '==') return val === value;
                if (operator === '>=') return val >= value;
                if (operator === '<=') return val <= value;
                if (operator === 'array-contains') return Array.isArray(val) && val.includes(value);
                return true;
              });
            }
            if (con.type === 'limit') {
              docs = docs.slice(0, con.value);
            }
          }
        }
        return res.json({ success: true, data: docs });
      }

      if (action === 'setDoc') {
        if (!dbData[collectionName]) dbData[collectionName] = {};
        const currentDoc = dbData[collectionName][docId] || {};
        if (options && options.merge) {
          dbData[collectionName][docId] = { ...currentDoc, ...data };
        } else {
          dbData[collectionName][docId] = data;
        }
        writeDb(dbData);
        return res.json({ success: true });
      }

      if (action === 'addDoc') {
        if (!dbData[collectionName]) dbData[collectionName] = {};
        const newId = collectionName.substring(0, 3) + '-' + Math.random().toString(36).substring(2, 9);
        dbData[collectionName][newId] = { ...data, id: newId };
        writeDb(dbData);
        return res.json({ success: true, id: newId });
      }

      if (action === 'updateDoc') {
        const col = dbData[collectionName] || {};
        if (col[docId]) {
          col[docId] = { ...col[docId], ...data };
          writeDb(dbData);
          return res.json({ success: true });
        } else {
          return res.status(404).json({ error: `Document ${docId} not found in ${collectionName}` });
        }
      }

      if (action === 'deleteDoc') {
        if (dbData[collectionName] && dbData[collectionName][docId]) {
          delete dbData[collectionName][docId];
          writeDb(dbData);
        }
        return res.json({ success: true });
      }

      if (action === 'batch') {
        if (operations && Array.isArray(operations)) {
          for (const op of operations) {
            const { action: opAction, collectionName: opCol, docId: opId, data: opData, options: opOpt } = op;
            if (!dbData[opCol]) dbData[opCol] = {};
            if (opAction === 'setDoc') {
              const current = dbData[opCol][opId] || {};
              if (opOpt && opOpt.merge) {
                dbData[opCol][opId] = { ...current, ...opData };
              } else {
                dbData[opCol][opId] = opData;
              }
            } else if (opAction === 'updateDoc') {
              if (dbData[opCol][opId]) {
                dbData[opCol][opId] = { ...dbData[opCol][opId], ...opData };
              }
            } else if (opAction === 'deleteDoc') {
              delete dbData[opCol][opId];
            }
          }
          writeDb(dbData);
          return res.json({ success: true });
        }
      }

      return res.status(400).json({ error: `Unknown action: ${action}` });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // Local Mock Auth Login Endpoint
  app.post('/api/mock-auth/login', (req, res) => {
    try {
      const { email, password } = req.body;
      const dbData = readDb();
      const usersCol = dbData['users'] || {};
      const user = Object.values(usersCol).find((u: any) => u.email === email);
      if (!user) {
        // Fallback: auto-seed from USERS_SEED if email matches
        const demoCitizen = USERS_SEED.find(u => u.email === email);
        if (demoCitizen) {
          if (!dbData['users']) dbData['users'] = {};
          dbData['users'][demoCitizen.uid] = demoCitizen;
          writeDb(dbData);
          return res.json({ success: true, user: demoCitizen });
        }
        return res.status(401).json({ error: 'User not found in demo database.' });
      }
      return res.json({ success: true, user });
    } catch (e: any) {
      return res.status(500).json({ error: e.message });
    }
  });

  // API Health Check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
  });

  // Triage Report Endpoint
  app.post('/api/triage', async (req, res) => {
    try {
      const { description, submittedCategory, mediaUrls, latitude, longitude } = req.body;
      if (!description) {
        return res.status(400).json({ error: 'Description is required for triage.' });
      }

      console.log(`[CivicResolve Server] Triage requested: "${description.substring(0, 50)}..."`);
      
      // Perform Server-Side Gemini Triage
      const analysis = await analyzeIncidentReport(
        description,
        submittedCategory || null,
        mediaUrls || [],
        latitude,
        longitude
      );

      // Perform Deterministic Priority Scoring
      const severityInt = analysis.severity;
      const categoryStr = analysis.category;
      const evidenceQuality = analysis.evidenceQuality;

      const priorityResult = calculatePriorityScore(
        severityInt,
        categoryStr,
        description,
        '', // landmark
        0,  // community confirmations start at 0
        new Date().toISOString(),
        evidenceQuality
      );

      return res.json({ 
        success: true, 
        analysis,
        deterministicPriority: priorityResult
      });
    } catch (error: any) {
      console.error('[CivicResolve Server] Triage endpoint error:', error);
      return res.status(500).json({ error: error.message || 'Error running AI triage' });
    }
  });

  // Check Duplicates Endpoint
  app.post('/api/check-duplicates', async (req, res) => {
    try {
      const { latitude, longitude, category, description } = req.body;
      if (latitude === undefined || longitude === undefined || !category || !description) {
        return res.status(400).json({ error: 'Latitude, longitude, category, and description are required.' });
      }

      const reportTime = new Date().toISOString();
      const cutoffTime = new Date(Date.now() - 21 * 24 * 60 * 60 * 1000).toISOString();

      // Retrieve open/active incidents within the last 21 days
      const incidentsSnap = await db.collection('incidents')
        .where('createdAt', '>=', cutoffTime)
        .get();

      const candidates: any[] = [];
      incidentsSnap.forEach(docSnap => {
        const data = docSnap.data();
        if (data.status !== 'RESOLVED' && data.status !== 'REJECTED' && data.status !== 'DUPLICATE_MERGED') {
          candidates.push({ id: docSnap.id, ...data });
        }
      });

      const duplicates = candidates.map(cand => {
        const reportObj = {
          description,
          category,
          latitude,
          longitude,
          createdAt: reportTime
        };

        const candObj = {
          id: cand.id,
          incidentCode: cand.incidentCode,
          title: cand.title,
          description: cand.aiAnalysis?.explanation || cand.title,
          category: cand.category,
          latitude: cand.location?.latitude || 0,
          longitude: cand.location?.longitude || 0,
          createdAt: cand.createdAt
        };

        return evaluateDuplicateCandidate(reportObj, candObj);
      }).filter(res => res.totalScore >= 60); // Filter candidates with score >= 60

      return res.json({ success: true, duplicates });
    } catch (error: any) {
      console.error('[CivicResolve Server] Check duplicates error:', error);
      return res.status(500).json({ error: error.message || 'Error analyzing duplicates' });
    }
  });

  // Secure validated State Transitions endpoint
  app.post('/api/transition', async (req, res) => {
    try {
      const authUser = await authenticateRequest(req);
      const { incidentId, action, notes, departmentId, priorityLevel, evidenceUrl, costReference, masterIncidentId } = req.body;

      if (!incidentId || !action) {
        return res.status(400).json({ error: 'IncidentId and action are required.' });
      }

      // Fetch current incident state from Firestore
      const incRef = db.collection('incidents').doc(incidentId);
      const incSnap = await incRef.get();
      if (!incSnap.exists) {
        return res.status(404).json({ error: `Incident ${incidentId} not found.` });
      }

      const incident = incSnap.data() as any;
      const currentStatus = incident.status;

      console.log(`[CivicResolve Server] State Transition Request: Incident ${incident.incidentCode} (${currentStatus}) -> Action: ${action} by User: ${authUser.name} (${authUser.role})`);

      let nextStatus = currentStatus;
      let auditMessage = '';
      let updates: Record<string, any> = { updatedAt: new Date().toISOString() };

      // Validate transitions using strict business logic
      if (action === 'SUBMIT_REPORT') {
        // Citizen DRAFT -> SUBMITTED
        if (authUser.role !== 'CITIZEN' && authUser.role !== 'ADMIN') {
          return res.status(403).json({ error: 'Only citizens can submit draft reports.' });
        }
        if (currentStatus !== 'DRAFT') {
          return res.status(400).json({ error: `Invalid transition from ${currentStatus} for action SUBMIT_REPORT.` });
        }
        nextStatus = 'SUBMITTED';
        auditMessage = `Draft report submitted to municipal queue.`;

      } else if (action === 'ADMIN_ASSIGN') {
        // Admin: PENDING_ADMIN_REVIEW / RETURNED_TO_ADMIN / REOPENED -> ASSIGNED_TO_DEPARTMENT
        if (authUser.role !== 'ADMIN') {
          return res.status(403).json({ error: 'Only Administrators can assign cases.' });
        }
        const allowedStatuses = ['PENDING_ADMIN_REVIEW', 'RETURNED_TO_ADMIN', 'REOPENED', 'SUBMITTED', 'AI_TRIAGED'];
        if (!allowedStatuses.includes(currentStatus)) {
          return res.status(400).json({ error: `Invalid transition from ${currentStatus} for action ADMIN_ASSIGN.` });
        }
        if (!departmentId) {
          return res.status(400).json({ error: 'Department ID is required for assignment.' });
        }

        const deptName = departmentId === 'roads' ? 'Roads & Maintenance' :
                         departmentId === 'electrical' ? 'Electrical Services' :
                         departmentId === 'water' ? 'Water Services' :
                         departmentId === 'sanitation' ? 'Sanitation Department' :
                         'General Administration';

        nextStatus = 'ASSIGNED_TO_DEPARTMENT';
        updates.assignedDepartmentId = departmentId;
        updates.assignedDepartmentName = deptName;
        if (priorityLevel) {
          updates.priorityLevel = priorityLevel;
          updates.isPriorityManuallyAdjusted = true;
          updates.priorityAdjustmentReason = notes || 'Priority manually verified by administrator.';
        }

        auditMessage = `Admin assigned case to department ${deptName}. Priority level set to ${priorityLevel || incident.priorityLevel}.` + 
                       (notes ? ` Notes: "${notes}"` : '');

        // Generate notification for department
        const notifId = 'notif-' + Math.random().toString(36).substring(2, 9);
        await db.collection('notifications').doc(notifId).set({
          id: notifId,
          recipientId: `dept-${departmentId}`,
          type: 'DEPARTMENT_ASSIGNMENT',
          title: 'New Maintenance Assignment',
          message: `Case ${incident.incidentCode} (${incident.category}) has been assigned to your sector.`,
          incidentId: incidentId,
          isRead: false,
          createdAt: new Date().toISOString()
        });

      } else if (action === 'ADMIN_REJECT') {
        // Admin: PENDING_ADMIN_REVIEW / RETURNED_TO_ADMIN -> REJECTED
        if (authUser.role !== 'ADMIN') {
          return res.status(403).json({ error: 'Only Administrators can reject cases.' });
        }
        const allowedStatuses = ['PENDING_ADMIN_REVIEW', 'RETURNED_TO_ADMIN', 'SUBMITTED', 'AI_TRIAGED'];
        if (!allowedStatuses.includes(currentStatus)) {
          return res.status(400).json({ error: `Invalid transition from ${currentStatus} for action ADMIN_REJECT.` });
        }
        if (!notes || notes.trim() === '') {
          return res.status(400).json({ error: 'Rejection reason notes are required.' });
        }

        nextStatus = 'REJECTED';
        auditMessage = `Incident report rejected by administration. Reason: "${notes}"`;

        // Notify reporter
        const notifId = 'notif-' + Math.random().toString(36).substring(2, 9);
        await db.collection('notifications').doc(notifId).set({
          id: notifId,
          recipientId: incident.reporterId || 'anonymous',
          type: 'REPORT_REJECTED',
          title: 'Report Update: Rejected',
          message: `Your report ${incident.incidentCode} was rejected. Reason: ${notes}`,
          incidentId: incidentId,
          isRead: false,
          createdAt: new Date().toISOString()
        });

      } else if (action === 'DEPT_ACCEPT') {
        // Department Manager: ASSIGNED_TO_DEPARTMENT -> ACCEPTED_BY_DEPARTMENT
        if (authUser.role !== 'DEPARTMENT_MANAGER') {
          return res.status(403).json({ error: 'Only assigned Department Managers can accept cases.' });
        }
        if (currentStatus !== 'ASSIGNED_TO_DEPARTMENT') {
          return res.status(400).json({ error: `Invalid transition from ${currentStatus} for action DEPT_ACCEPT.` });
        }
        if (incident.assignedDepartmentId !== authUser.departmentId) {
          return res.status(403).json({ error: `This incident is assigned to ${incident.assignedDepartmentId}, but you belong to ${authUser.departmentId}.` });
        }

        nextStatus = 'ACCEPTED_BY_DEPARTMENT';
        auditMessage = `Department manager ${authUser.name} accepted the work order into the sector queue. SLA target countdown initiated.`;

        // Notify reporter
        const notifId = 'notif-' + Math.random().toString(36).substring(2, 9);
        await db.collection('notifications').doc(notifId).set({
          id: notifId,
          recipientId: incident.reporterId || 'anonymous',
          type: 'CASE_ACCEPTED',
          title: 'Repairs Dispatched',
          message: `Veridale City Council has dispatched your case ${incident.incidentCode} to the active repair schedule.`,
          incidentId: incidentId,
          isRead: false,
          createdAt: new Date().toISOString()
        });

      } else if (action === 'DEPT_RETURN') {
        // Department Manager: ASSIGNED_TO_DEPARTMENT -> RETURNED_TO_ADMIN
        if (authUser.role !== 'DEPARTMENT_MANAGER') {
          return res.status(403).json({ error: 'Only Department Managers can return cases to Admin.' });
        }
        if (currentStatus !== 'ASSIGNED_TO_DEPARTMENT') {
          return res.status(400).json({ error: `Invalid transition from ${currentStatus} for action DEPT_RETURN.` });
        }
        if (!notes || notes.trim() === '') {
          return res.status(400).json({ error: 'Notes explaining return reasons are required.' });
        }

        nextStatus = 'RETURNED_TO_ADMIN';
        auditMessage = `Department manager returned the ticket to administration review pool. Reason: "${notes}"`;

      } else if (action === 'DEPT_START_WORK') {
        // Department Manager: ACCEPTED_BY_DEPARTMENT -> IN_PROGRESS
        if (authUser.role !== 'DEPARTMENT_MANAGER') {
          return res.status(403).json({ error: 'Only Department Managers can initiate repairs.' });
        }
        if (currentStatus !== 'ACCEPTED_BY_DEPARTMENT' && currentStatus !== 'ASSIGNED_TO_DEPARTMENT') {
          return res.status(400).json({ error: `Invalid transition from ${currentStatus} for action DEPT_START_WORK.` });
        }

        nextStatus = 'IN_PROGRESS';
        auditMessage = `Maintenance crews successfully mobilized on-site. Repair operations initiated.`;

      } else if (action === 'DEPT_UPDATE_PROGRESS') {
        // Department Manager logs intermediate progress note
        if (authUser.role !== 'DEPARTMENT_MANAGER') {
          return res.status(403).json({ error: 'Only Department Managers can add progress updates.' });
        }
        if (!notes || notes.trim() === '') {
          return res.status(400).json({ error: 'Progress notes are required.' });
        }
        auditMessage = `Department progress update: "${notes}"` + (evidenceUrl ? ' (Progress photo uploaded)' : '');

        // Write WorkUpdate Log
        const updateId = 'upd-' + Math.random().toString(36).substring(2, 9);
        await db.collection('workUpdates').doc(updateId).set({
          id: updateId,
          incidentId: incidentId,
          departmentId: authUser.departmentId || 'general',
          authorId: authUser.uid,
          authorName: authUser.name,
          note: notes,
          statusAfterUpdate: currentStatus,
          evidenceUrls: evidenceUrl ? [evidenceUrl] : [],
          createdAt: new Date().toISOString()
        });

      } else if (action === 'DEPT_SUBMIT_PROOF' || action === 'DEPT_SUBMIT_RESOLVE') {
        // Department Manager: IN_PROGRESS -> RESOLUTION_EVIDENCE_SUBMITTED
        if (authUser.role !== 'DEPARTMENT_MANAGER') {
          return res.status(403).json({ error: 'Only Department Managers can submit repair proofs.' });
        }
        if (currentStatus !== 'IN_PROGRESS' && currentStatus !== 'ACCEPTED_BY_DEPARTMENT') {
          return res.status(400).json({ error: `Invalid transition from ${currentStatus} for action DEPT_SUBMIT_PROOF.` });
        }
        if (!notes || notes.trim() === '') {
          return res.status(400).json({ error: 'Completion log notes are required.' });
        }
        if (!evidenceUrl) {
          return res.status(400).json({ error: 'At least one evidence photo of the repair work is mandatory.' });
        }

        nextStatus = 'PENDING_ADMIN_VERIFICATION'; // Transitions to verification directly so admins can sign off
        updates.resolutionEvidenceUrl = evidenceUrl;
        auditMessage = `Department submitted completion logs and uploaded repair evidence for inspection.`;

        // 1. Write WorkUpdate Log
        const updateId = 'upd-' + Math.random().toString(36).substring(2, 9);
        await db.collection('workUpdates').doc(updateId).set({
          id: updateId,
          incidentId: incidentId,
          departmentId: authUser.departmentId || 'general',
          authorId: authUser.uid,
          authorName: authUser.name,
          note: notes,
          statusAfterUpdate: 'RESOLUTION_EVIDENCE_SUBMITTED',
          evidenceUrls: [evidenceUrl],
          createdAt: new Date().toISOString()
        });

        // Notify Admin of completed task
        const notifId = 'notif-' + Math.random().toString(36).substring(2, 9);
        await db.collection('notifications').doc(notifId).set({
          id: notifId,
          recipientId: 'admin',
          type: 'RESOLUTION_EVIDENCE_SUBMITTED',
          title: 'Verification Needed',
          message: `Department completed repairs on ${incident.incidentCode}. Admin verification required.`,
          incidentId: incidentId,
          isRead: false,
          createdAt: new Date().toISOString()
        });

      } else if (action === 'ADMIN_VERIFY_RESOLVE') {
        // Admin: PENDING_ADMIN_VERIFICATION -> RESOLVED
        if (authUser.role !== 'ADMIN') {
          return res.status(403).json({ error: 'Only Administrators can verify resolutions.' });
        }
        if (currentStatus !== 'PENDING_ADMIN_VERIFICATION') {
          return res.status(400).json({ error: `Invalid transition from ${currentStatus} for action ADMIN_VERIFY_RESOLVE.` });
        }

        nextStatus = 'RESOLVED';
        updates.resolvedAt = new Date().toISOString();
        auditMessage = `Admin physically verified proof photo and signed off, marking ticket fully RESOLVED.`;

        // Notify reporter
        const notifId = 'notif-' + Math.random().toString(36).substring(2, 9);
        await db.collection('notifications').doc(notifId).set({
          id: notifId,
          recipientId: incident.reporterId || 'anonymous',
          type: 'CASE_RESOLVED',
          title: 'Issue Resolved!',
          message: `Veridale City has resolved report ${incident.incidentCode}! View repair details and closure notes.`,
          incidentId: incidentId,
          isRead: false,
          createdAt: new Date().toISOString()
        });

      } else if (action === 'ADMIN_VERIFY_RETURN') {
        // Admin: PENDING_ADMIN_VERIFICATION -> IN_PROGRESS (Returned to Department)
        if (authUser.role !== 'ADMIN') {
          return res.status(403).json({ error: 'Only Administrators can reject proof.' });
        }
        if (currentStatus !== 'PENDING_ADMIN_VERIFICATION') {
          return res.status(400).json({ error: `Invalid transition from ${currentStatus} for action ADMIN_VERIFY_RETURN.` });
        }
        if (!notes || notes.trim() === '') {
          return res.status(400).json({ error: 'Feedback comments explaining the return are required.' });
        }

        nextStatus = 'IN_PROGRESS';
        auditMessage = `Admin rejected repair evidence. Returned to the assigned department for additional work. Feedback: "${notes}"`;

        // Notify department
        const notifId = 'notif-' + Math.random().toString(36).substring(2, 9);
        await db.collection('notifications').doc(notifId).set({
          id: notifId,
          recipientId: `dept-${incident.assignedDepartmentId}`,
          type: 'RESOLUTION_REJECTED',
          title: 'Resolution Rejected',
          message: `Admin rejected repair proof for ${incident.incidentCode}. Feedback: ${notes}`,
          incidentId: incidentId,
          isRead: false,
          createdAt: new Date().toISOString()
        });

      } else if (action === 'CITIZEN_CONFIRM') {
        // Each authenticated user may verify an existing report only once.
        const confirmedByUserIds = Array.isArray(incident.confirmedByUserIds)
          ? incident.confirmedByUserIds
          : [];
        if (confirmedByUserIds.includes(authUser.uid)) {
          return res.status(409).json({ error: 'You have already confirmed this issue.' });
        }

        const currentCount = incident.confirmationCount || 0;
        updates.confirmationCount = currentCount + 1;
        updates.confirmedByUserIds = [...confirmedByUserIds, authUser.uid];
        auditMessage = `Citizen ${authUser.name} verified this report. Total local confirmations increased to ${updates.confirmationCount}.`;

      } else if (action === 'CITIZEN_REOPEN') {
        // Citizen: RESOLVED -> REOPENED
        if (currentStatus !== 'RESOLVED') {
          return res.status(400).json({ error: `Invalid transition from ${currentStatus} for action CITIZEN_REOPEN.` });
        }
        if (!notes || notes.trim() === '') {
          return res.status(400).json({ error: 'A valid reason for reopening the case is mandatory.' });
        }

        const currentReopenedCount = incident.reopenedCount || 0;
        nextStatus = 'REOPENED';
        updates.reopenedCount = currentReopenedCount + 1;
        updates.resolvedAt = null;

        auditMessage = `Incident ticket reopened by citizen ${authUser.name}. Reason: "${notes}"`;
        if (evidenceUrl) {
          auditMessage += ` [Reopening photo evidence uploaded]`;
        }

        // Notify Admin of Reopening
        const notifId = 'notif-' + Math.random().toString(36).substring(2, 9);
        await db.collection('notifications').doc(notifId).set({
          id: notifId,
          recipientId: 'admin',
          type: 'CASE_REOPENED',
          title: 'Ticket Reopened',
          message: `Citizen reopened resolved ticket ${incident.incidentCode}. Reason: ${notes}`,
          incidentId: incidentId,
          isRead: false,
          createdAt: new Date().toISOString()
        });

      } else if (action === 'ADMIN_MERGE_DUPLICATE') {
        // Admin: PENDING_ADMIN_REVIEW -> DUPLICATE_MERGED
        if (authUser.role !== 'ADMIN') {
          return res.status(403).json({ error: 'Only Administrators can merge reports.' });
        }
        const allowedStatuses = ['PENDING_ADMIN_REVIEW', 'SUBMITTED', 'AI_TRIAGED'];
        if (!allowedStatuses.includes(currentStatus)) {
          return res.status(400).json({ error: `Invalid transition from ${currentStatus} for action ADMIN_MERGE_DUPLICATE.` });
        }
        if (!masterIncidentId) {
          return res.status(400).json({ error: 'MasterIncidentId is required to perform duplicate merging.' });
        }

        const masterRef = db.collection('incidents').doc(masterIncidentId);
        const masterSnap = await masterRef.get();
        if (!masterSnap.exists) {
          return res.status(404).json({ error: `Master incident ${masterIncidentId} not found.` });
        }

        const masterData = masterSnap.data() as any;

        nextStatus = 'DUPLICATE_MERGED';
        updates.masterIncidentId = masterIncidentId;

        // Update master counts
        const mergedReports = (masterData.reportCount || 1) + (incident.reportCount || 1);
        const dupCandidates = [...(masterData.duplicateCandidateIds || []), incidentId];

        await masterRef.update({
          reportCount: mergedReports,
          duplicateCandidateIds: dupCandidates,
          updatedAt: new Date().toISOString()
        });

        // Log timeline events
        auditMessage = `Admin merged this incident as a duplicate of master incident ${masterData.incidentCode}.`;

        const masterEventId = 'evt-' + Math.random().toString(36).substring(2, 9);
        await db.collection('incidentEvents').doc(masterEventId).set({
          id: masterEventId,
          incidentId: masterIncidentId,
          eventType: 'CASE_MERGED_AS_DUPLICATE',
          actorId: authUser.uid,
          actorName: authUser.name,
          actorRole: authUser.role as any,
          message: `Admin merged duplicate incident ${incident.incidentCode} into this master ticket. Consolidation report count: ${mergedReports}.`,
          createdAt: new Date().toISOString()
        });

      } else {
        return res.status(400).json({ error: `Unsupported transition action: ${action}` });
      }

      // Check if Priority needs dynamic updating (e.g. on confirmation or time elapsed)
      if (nextStatus !== currentStatus) {
        updates.status = nextStatus;
      }

      // Recalculate deterministic priority score if not manually locked
      if (!incident.isPriorityManuallyAdjusted && incident.aiAnalysis) {
        const confirmations = updates.confirmationCount ?? incident.confirmationCount ?? 0;
        const severityVal = incident.aiAnalysis.severity || 3;
        const categoryVal = incident.category || 'OTHER';
        const descriptionVal = incident.aiAnalysis.explanation || incident.title;
        const evidenceQualityVal = incident.aiAnalysis.evidenceQuality || 'FAIR';

        const recalc = calculatePriorityScore(
          severityVal,
          categoryVal,
          descriptionVal,
          '', // landmark
          confirmations,
          incident.createdAt,
          evidenceQualityVal
        );

        updates.priorityScore = recalc.score;
        updates.priorityLevel = recalc.level;
      }

      // Commit Updates to Incident
      await incRef.update(updates);

      // Create Audit Timeline Event
      const eventId = 'evt-' + Math.random().toString(36).substring(2, 9);
      await db.collection('incidentEvents').doc(eventId).set({
        id: eventId,
        incidentId: incidentId,
        eventType: action,
        actorId: authUser.uid,
        actorName: authUser.name,
        actorRole: authUser.role as any,
        message: auditMessage,
        createdAt: new Date().toISOString()
      });

      return res.json({ 
        success: true, 
        nextStatus, 
        message: 'Status transition processed successfully!',
        updatedPriority: {
          score: updates.priorityScore || incident.priorityScore,
          level: updates.priorityLevel || incident.priorityLevel
        }
      });
    } catch (error: any) {
      console.error('[CivicResolve Server] Secure transition error:', error);
      return res.status(500).json({ error: error.message || 'Error executing transition' });
    }
  });

  // Seed Demo Data Endpoint (Fully implements complex custom scenario)
  app.post('/api/seed', async (req, res) => {
    try {
      const { force } = req.body;
      const deptSnap = await db.collection('departments').limit(1).get();
      if (!deptSnap.empty && !force) {
        return res.json({ 
          success: true, 
          message: 'Database already has data. Use { "force": true } to re-seed and overwrite.' 
        });
      }

      console.log('[CivicResolve Server] Seeding databases started...');
      const batch = db.batch();

      // 1. Seed Departments
      for (const dept of DEPARTMENTS_SEED) {
        const docRef = db.collection('departments').doc(dept.id);
        batch.set(docRef, dept, { merge: true });
      }

      // 2. Seed Users
      for (const user of USERS_SEED) {
        const docRef = db.collection('users').doc(user.uid);
        batch.set(docRef, user, { merge: true });
      }

      // 3. Seed Incidents
      for (const inc of INCIDENTS_SEED) {
        const docRef = db.collection('incidents').doc(inc.id);
        batch.set(docRef, inc, { merge: true });
      }

      // 4. Seed Reports
      for (const rep of REPORTS_SEED) {
        const docRef = db.collection('reports').doc(rep.id);
        batch.set(docRef, rep, { merge: true });
      }

      // 5. Seed Timeline Events
      for (const evt of EVENTS_SEED) {
        const docRef = db.collection('incidentEvents').doc(evt.id);
        batch.set(docRef, evt, { merge: true });
      }

      await batch.commit();
      console.log('[CivicResolve Server] Seeding completed successfully!');
      
      return res.json({ 
        success: true, 
        message: 'Successfully seeded 5 departments, 6 demo users, 20 incidents, and initial timeline events!' 
      });
    } catch (error: any) {
      console.error('[CivicResolve Server] Seeding failed:', error);
      return res.status(500).json({ error: error.message || 'Error seeding database' });
    }
  });

async function startServer() {
  const configuredPort = Number.parseInt(process.env.PORT || '3000', 10);
  const PORT = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
    ? configuredPort
    : 3000;

  // Start dev server middleware or static assets serving
  if (!isProduction) {
    console.log('[CivicResolve Server] Starting in DEVELOPMENT mode with Vite middleware...');
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    console.log('[CivicResolve Server] Starting in PRODUCTION mode...');
    if (demoApiEnabled) {
      console.warn('[CivicResolve Server] WARNING: insecure local demo APIs are explicitly enabled in production.');
    }
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[CivicResolve Server] Listening on http://localhost:${PORT}`);
  });
}

if (!process.env.VERCEL) {
  startServer().catch((err) => {
    console.error('[CivicResolve Server] Failed to start server:', err);
  });
}

export default app;

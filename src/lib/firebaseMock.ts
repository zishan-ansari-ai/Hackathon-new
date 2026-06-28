/**
 * Mock implementation of Firebase App, Auth, Firestore, and Storage for local sandbox environment.
 * Bypasses network requests and credentials by calling local backend APIs and using localStorage.
 */

// --- Firebase App Mock ---
export function initializeApp() {
  return {};
}
export function getApps() {
  return [{}];
}
export function getApp() {
  return {};
}

// --- Firebase Auth Mock ---
const authListeners = new Set<(user: any) => void>();

export const auth = {
  get currentUser() {
    const userStr = localStorage.getItem('civicresolve_user');
    if (userStr) {
      try {
        const parsed = JSON.parse(userStr);
        return {
          uid: parsed.uid,
          email: parsed.email,
          displayName: parsed.name,
          getIdToken: async () => parsed.uid,
          emailVerified: true,
          isAnonymous: false,
          tenantId: null,
          providerData: []
        };
      } catch (e) {
        return null;
      }
    }
    return null;
  }
};

export function getAuth() {
  return auth;
}

export function onAuthStateChanged(authObj: any, callback: any) {
  authListeners.add(callback);
  // Emit current state
  callback(auth.currentUser);
  return () => {
    authListeners.delete(callback);
  };
}

function triggerAuthListeners() {
  const user = auth.currentUser;
  authListeners.forEach(listener => {
    try {
      listener(user);
    } catch (e) {
      console.error(e);
    }
  });
}

export async function signInWithEmailAndPassword(authObj: any, email: string, password: any) {
  // Sync first to make sure any local users/data are uploaded
  await syncLocalDBWithServer();

  let res = await fetch('/api/mock-auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });

  // Self-heal: If user is not found on server (container reset), restore from local storage
  if (res.status === 401) {
    try {
      const localDbStr = localStorage.getItem('civicresolve_local_db');
      if (localDbStr) {
        const localDb = JSON.parse(localDbStr);
        const usersCol = localDb['users'] || {};
        const localUser = Object.values(usersCol).find((u: any) => u.email === email);
        if (localUser) {
          console.log(`[CivicResolve Sync] Found registered user ${email} in local storage. Restoring to server...`);
          await fetch('/api/mock-db', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              action: 'setDoc',
              collectionName: 'users',
              docId: (localUser as any).uid,
              data: localUser
            })
          });
          // Retry login
          res = await fetch('/api/mock-auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password })
          });
        }
      }
    } catch (err) {
      console.error('Error during local user recovery:', err);
    }
  }

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data.error || 'Authentication failed');
  }
  
  localStorage.setItem('civicresolve_user', JSON.stringify(data.user));
  triggerAuthListeners();
  
  return {
    user: {
      uid: data.user.uid,
      email: data.user.email,
      displayName: data.user.name,
      getIdToken: async () => data.user.uid
    }
  };
}

export async function createUserWithEmailAndPassword(authObj: any, email: string, password: any) {
  const uid = 'user-' + Math.random().toString(36).substring(2, 11);
  const user = {
    uid,
    name: email.split('@')[0],
    email,
    role: 'CITIZEN',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isActive: true
  };

  saveToLocalDB('users', uid, user);

  const res = await fetch('/api/mock-db', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'setDoc',
      collectionName: 'users',
      docId: uid,
      data: user
    })
  });
  if (!res.ok) {
    const errData = await res.json();
    throw new Error(errData.error || 'Failed to create account');
  }

  localStorage.setItem('civicresolve_user', JSON.stringify(user));
  triggerAuthListeners();

  return {
    user: {
      uid,
      email,
      displayName: user.name,
      getIdToken: async () => uid
    }
  };
}

export async function signOut(authObj: any) {
  localStorage.removeItem('civicresolve_user');
  triggerAuthListeners();
}

export async function updateProfile(userObj: any, profileData: any) {
  // Mock profile update
  return;
}

// --- Firebase Firestore Mock ---
export const db = {
  type: 'db'
};

export function initializeFirestore() {
  return db;
}

export function getFirestore() {
  return db;
}

export function doc(dbObj: any, collectionName: string, docId: string) {
  return { type: 'document', collectionName, docId };
}

export function collection(dbObj: any, collectionName: string) {
  return { type: 'collection', collectionName };
}

export function query(collectionRef: any, ...constraints: any[]) {
  return { type: 'query', collectionRef, constraints };
}

export function where(field: string, operator: string, value: any) {
  return { type: 'where', field, operator, value };
}

export function limit(value: number) {
  return { type: 'limit', value };
}

class MockDocumentSnapshot {
  id: string;
  private _data: any;
  constructor(id: string, data: any) {
    this.id = id;
    this._data = data;
  }
  exists() {
    return this._data !== null && this._data !== undefined;
  }
  data() {
    return this._data;
  }
}

class MockQuerySnapshot {
  docs: MockDocumentSnapshot[];
  constructor(docs: MockDocumentSnapshot[]) {
    this.docs = docs;
  }
  get empty() {
    return this.docs.length === 0;
  }
  get size() {
    return this.docs.length;
  }
  forEach(callback: (doc: MockDocumentSnapshot) => void) {
    this.docs.forEach(callback);
  }
}

function getCurrentUserToken() {
  const user = localStorage.getItem('civicresolve_user');
  if (user) {
    try {
      return JSON.parse(user).uid;
    } catch (e) {
      return '';
    }
  }
  return '';
}

// Local storage cache for offline/serverless durability
function saveToLocalDB(collectionName: string, docId: string, data: any) {
  try {
    const localDbStr = localStorage.getItem('civicresolve_local_db');
    const localDb = localDbStr ? JSON.parse(localDbStr) : {};
    if (!localDb[collectionName]) localDb[collectionName] = {};
    localDb[collectionName][docId] = data;
    localStorage.setItem('civicresolve_local_db', JSON.stringify(localDb));
  } catch (e) {
    console.error('Failed to save to local DB:', e);
  }
}

function deleteFromLocalDB(collectionName: string, docId: string) {
  try {
    const localDbStr = localStorage.getItem('civicresolve_local_db');
    if (localDbStr) {
      const localDb = JSON.parse(localDbStr);
      if (localDb[collectionName]) {
        delete localDb[collectionName][docId];
        localStorage.setItem('civicresolve_local_db', JSON.stringify(localDb));
      }
    }
  } catch (e) {
    console.error('Failed to delete from local DB:', e);
  }
}

let isSyncing = false;
export async function syncLocalDBWithServer() {
  if (isSyncing) return;
  try {
    const localDbStr = localStorage.getItem('civicresolve_local_db');
    if (!localDbStr) return;
    const localDb = JSON.parse(localDbStr);
    
    const collections = Object.keys(localDb);
    if (collections.length === 0) return;

    isSyncing = true;
    
    const res = await fetch('/api/mock-db/all', {
      headers: {
        'Authorization': `Bearer ${getCurrentUserToken()}`
      }
    });
    if (!res.ok) return;
    const payload = await res.json();
    const serverDb = payload.db || {};

    const operations: any[] = [];
    
    for (const colName of collections) {
      const colDocs = localDb[colName] || {};
      const serverColDocs = serverDb[colName] || {};
      
      for (const [docId, docData] of Object.entries(colDocs)) {
        const serverDoc = serverColDocs[docId];
        const localUpdatedAt = (docData as any)?.updatedAt ? new Date((docData as any).updatedAt).getTime() : 0;
        const serverUpdatedAt = (serverDoc as any)?.updatedAt ? new Date((serverDoc as any).updatedAt).getTime() : 0;

        if (!serverDoc || localUpdatedAt > serverUpdatedAt) {
          operations.push({
            action: 'setDoc',
            collectionName: colName,
            docId,
            data: docData
          });
        }
      }
    }

    if (operations.length > 0) {
      console.log(`[CivicResolve Sync] Restoring ${operations.length} missing/updated documents to server mock DB...`);
      const batchSize = 25;
      for (let i = 0; i < operations.length; i += batchSize) {
        const batchOps = operations.slice(i, i + batchSize);
        await fetch('/api/mock-db', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${getCurrentUserToken()}`
          },
          body: JSON.stringify({
            action: 'batch',
            operations: batchOps
          })
        });
      }
      console.log('[CivicResolve Sync] Synchronization complete!');
    }
  } catch (e) {
    console.error('[CivicResolve Sync] Synchronization failed:', e);
  } finally {
    isSyncing = false;
  }
}

// Monkey patch fetch to trigger local DB sync and refresh poll after updates
const originalFetch = window.fetch;
window.fetch = async function(input, init) {
  const res = await originalFetch(input, init);
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.includes('/api/transition') || url.includes('/api/mock-db')) {
    setTimeout(() => {
      triggerGlobalPoll();
    }, 200);
  }
  return res;
};

export async function getDoc(docRef: any) {
  const res = await fetch('/api/mock-db', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getCurrentUserToken()}`
    },
    body: JSON.stringify({
      action: 'getDoc',
      collectionName: docRef.collectionName,
      docId: docRef.docId
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Firestore mock error');
  return new MockDocumentSnapshot(docRef.docId, data.data);
}

export async function getDocs(queryOrColRef: any) {
  const collectionName = queryOrColRef.type === 'query' 
    ? queryOrColRef.collectionRef.collectionName 
    : queryOrColRef.collectionName;
  
  const constraints = queryOrColRef.type === 'query' ? queryOrColRef.constraints : [];

  const res = await fetch('/api/mock-db', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getCurrentUserToken()}`
    },
    body: JSON.stringify({
      action: 'getDocs',
      collectionName,
      constraints
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Firestore mock error');
  
  const snapshots = data.data.map((item: any) => new MockDocumentSnapshot(item.id, item));
  return new MockQuerySnapshot(snapshots);
}

export async function setDoc(docRef: any, data: any, options?: any) {
  let finalData = data;
  if (options && options.merge) {
    try {
      const localDbStr = localStorage.getItem('civicresolve_local_db');
      const localDb = localDbStr ? JSON.parse(localDbStr) : {};
      const current = (localDb[docRef.collectionName] || {})[docRef.docId] || {};
      finalData = { ...current, ...data };
    } catch (e) {}
  }
  saveToLocalDB(docRef.collectionName, docRef.docId, finalData);

  const res = await fetch('/api/mock-db', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getCurrentUserToken()}`
    },
    body: JSON.stringify({
      action: 'setDoc',
      collectionName: docRef.collectionName,
      docId: docRef.docId,
      data,
      options
    })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to set document');
  }
}

export async function addDoc(collectionRef: any, data: any) {
  const res = await fetch('/api/mock-db', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getCurrentUserToken()}`
    },
    body: JSON.stringify({
      action: 'addDoc',
      collectionName: collectionRef.collectionName,
      data
    })
  });
  const resData = await res.json();
  if (!res.ok) {
    throw new Error(resData.error || 'Failed to add document');
  }
  saveToLocalDB(collectionRef.collectionName, resData.id, { ...data, id: resData.id });
  return { id: resData.id };
}

export async function updateDoc(docRef: any, data: any) {
  try {
    const localDbStr = localStorage.getItem('civicresolve_local_db');
    const localDb = localDbStr ? JSON.parse(localDbStr) : {};
    const current = (localDb[docRef.collectionName] || {})[docRef.docId] || {};
    const merged = { ...current, ...data };
    saveToLocalDB(docRef.collectionName, docRef.docId, merged);
  } catch (e) {}

  const res = await fetch('/api/mock-db', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getCurrentUserToken()}`
    },
    body: JSON.stringify({
      action: 'updateDoc',
      collectionName: docRef.collectionName,
      docId: docRef.docId,
      data
    })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to update document');
  }
}

export async function deleteDoc(docRef: any) {
  deleteFromLocalDB(docRef.collectionName, docRef.docId);

  const res = await fetch('/api/mock-db', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${getCurrentUserToken()}`
    },
    body: JSON.stringify({
      action: 'deleteDoc',
      collectionName: docRef.collectionName,
      docId: docRef.docId
    })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.error || 'Failed to delete document');
  }
}

export function writeBatch(dbObj: any) {
  const operations: any[] = [];
  const localOps: { action: string, collectionName: string, docId: string, data?: any, options?: any }[] = [];
  return {
    set(docRef: any, data: any, options?: any) {
      operations.push({ action: 'setDoc', collectionName: docRef.collectionName, docId: docRef.docId, data, options });
      localOps.push({ action: 'set', collectionName: docRef.collectionName, docId: docRef.docId, data, options });
    },
    update(docRef: any, data: any) {
      operations.push({ action: 'updateDoc', collectionName: docRef.collectionName, docId: docRef.docId, data });
      localOps.push({ action: 'update', collectionName: docRef.collectionName, docId: docRef.docId, data });
    },
    delete(docRef: any) {
      operations.push({ action: 'deleteDoc', collectionName: docRef.collectionName, docId: docRef.docId });
      localOps.push({ action: 'delete', collectionName: docRef.collectionName, docId: docRef.docId });
    },
    async commit() {
      try {
        const localDbStr = localStorage.getItem('civicresolve_local_db');
        const localDb = localDbStr ? JSON.parse(localDbStr) : {};
        
        for (const op of localOps) {
          if (!localDb[op.collectionName]) localDb[op.collectionName] = {};
          if (op.action === 'set') {
            const current = localDb[op.collectionName][op.docId] || {};
            if (op.options && op.options.merge) {
              localDb[op.collectionName][op.docId] = { ...current, ...op.data };
            } else {
              localDb[op.collectionName][op.docId] = op.data;
            }
          } else if (op.action === 'update') {
            const current = localDb[op.collectionName][op.docId] || {};
            localDb[op.collectionName][op.docId] = { ...current, ...op.data };
          } else if (op.action === 'delete') {
            delete localDb[op.collectionName][op.docId];
          }
        }
        localStorage.setItem('civicresolve_local_db', JSON.stringify(localDb));
      } catch (e) {
        console.error('Batch local save failed:', e);
      }

      const res = await fetch('/api/mock-db', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getCurrentUserToken()}`
        },
        body: JSON.stringify({
          action: 'batch',
          operations
        })
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to commit batch');
      }
    }
  };
}

const listeners = new Set<{
  id: string;
  type: 'document' | 'collection' | 'query';
  collectionName: string;
  docId?: string;
  constraints?: any[];
  callback: (snapshot: any) => void;
  lastJson: string;
}>();

let globalPollStarted = false;
let pollTimeoutId: any = null;

async function runPoll() {
  if (listeners.size === 0) {
    globalPollStarted = false;
    return;
  }

  try {
    const res = await fetch('/api/mock-db/all', {
      headers: {
        'Authorization': `Bearer ${getCurrentUserToken()}`
      }
    });
    if (res.ok) {
      const payload = await res.json();
      const dbData = payload.db || {};

      // Merge server changes into local DB
      try {
        const localDbStr = localStorage.getItem('civicresolve_local_db');
        const localDb = localDbStr ? JSON.parse(localDbStr) : {};
        let localModified = false;

        for (const colName of Object.keys(dbData)) {
          if (!localDb[colName]) {
            localDb[colName] = {};
          }
          for (const [docId, serverDoc] of Object.entries(dbData[colName])) {
            const localDoc = localDb[colName][docId];
            const localUpdatedAt = localDoc?.updatedAt ? new Date(localDoc.updatedAt).getTime() : 0;
            const serverUpdatedAt = (serverDoc as any)?.updatedAt ? new Date((serverDoc as any).updatedAt).getTime() : 0;
            
            if (!localDoc || serverUpdatedAt > localUpdatedAt) {
              localDb[colName][docId] = serverDoc;
              localModified = true;
            }
          }
        }

        if (localModified) {
          localStorage.setItem('civicresolve_local_db', JSON.stringify(localDb));
        }
      } catch (e) {
        console.error('[CivicResolve Sync] Error merging server updates to local DB:', e);
      }

      listeners.forEach(listener => {
        try {
          let dataToCompare: any;
          let snapshot: any;

          if (listener.type === 'document') {
            const col = dbData[listener.collectionName] || {};
            const docData = col[listener.docId!] || null;
            dataToCompare = docData;
            snapshot = new MockDocumentSnapshot(listener.docId!, docData);
          } else {
            const col = dbData[listener.collectionName] || {};
            let docs = Object.values(col);

            if (listener.constraints && Array.isArray(listener.constraints)) {
              for (const con of listener.constraints) {
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

            dataToCompare = docs;
            const snaps = docs.map((d: any) => new MockDocumentSnapshot(d.id || d.uid || '', d));
            snapshot = new MockQuerySnapshot(snaps);
          }

          const currentJson = JSON.stringify(dataToCompare);
          if (currentJson !== listener.lastJson) {
            listener.lastJson = currentJson;
            listener.callback(snapshot);
          }
        } catch (err) {
          console.error('[CivicResolve Sync] Listener update error:', err);
        }
      });
    }
  } catch (err) {
    console.error('[CivicResolve Sync] Global poll error:', err);
  }

  // Schedule next poll in 3 seconds
  if (pollTimeoutId) clearTimeout(pollTimeoutId);
  pollTimeoutId = setTimeout(runPoll, 3000);
}

export function triggerGlobalPoll() {
  if (pollTimeoutId) clearTimeout(pollTimeoutId);
  runPoll();
}

function startGlobalPoll() {
  if (globalPollStarted) return;
  globalPollStarted = true;
  runPoll();
}

export function onSnapshot(queryOrDocRef: any, callback: any, errorCallback?: any) {
  const id = Math.random().toString(36).substring(2, 11);
  const listener: any = {
    id,
    callback,
    lastJson: ''
  };

  if (queryOrDocRef.type === 'document') {
    listener.type = 'document';
    listener.collectionName = queryOrDocRef.collectionName;
    listener.docId = queryOrDocRef.docId;
  } else {
    listener.type = queryOrDocRef.type === 'query' ? 'query' : 'collection';
    listener.collectionName = queryOrDocRef.type === 'query' 
      ? queryOrDocRef.collectionRef.collectionName 
      : queryOrDocRef.collectionName;
    listener.constraints = queryOrDocRef.type === 'query' ? queryOrDocRef.constraints : [];
  }

  listeners.add(listener);
  
  // Trigger initial fetch from local DB immediately to prevent blank UI state.
  // Keep these branches separate so each snapshot has its correct concrete type.
  const handleError = (err: unknown) => {
    if (errorCallback) errorCallback(err);
  };

  if (listener.type === 'document') {
    getDoc(queryOrDocRef)
      .then(snapshot => {
        listener.lastJson = JSON.stringify(snapshot.data());
        callback(snapshot);
      })
      .catch(handleError);
  } else {
    getDocs(queryOrDocRef)
      .then(snapshot => {
        const dataToCompare = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
        listener.lastJson = JSON.stringify(dataToCompare);
        callback(snapshot);
      })
      .catch(handleError);
  }

  syncLocalDBWithServer();
  startGlobalPoll();

  return () => {
    listeners.delete(listener);
  };
}

// --- Firebase Storage Mock ---
export function getStorage() {
  return {};
}

export function ref(storageObj: any, pathStr: string) {
  return { pathStr };
}

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result);
      } else {
        reject(new Error('Unable to read the selected image.'));
      }
    };
    reader.onerror = () => reject(reader.error || new Error('Unable to read the selected image.'));
    reader.readAsDataURL(file);
  });
}

export function uploadBytes(refObj: any, file: any) {
  return readFileAsDataUrl(file).then(downloadUrl => {
    refObj.downloadUrl = downloadUrl;
    return { ref: refObj };
  });
}

export function uploadBytesResumable(refObj: any, file: any) {
  const uploadedImage = readFileAsDataUrl(file);
  const uploadTask = {
    snapshot: { ref: refObj },
    on(event: string, next: any, error?: any, complete?: any) {
      let progress = 0;
      const interval = setInterval(() => {
        progress += 25;
        try {
          next({ bytesTransferred: progress, totalBytes: 100 });
        } catch (e) {
          console.error(e);
        }
        if (progress === 100) {
          clearInterval(interval);
          uploadedImage
            .then(downloadUrl => {
              refObj.downloadUrl = downloadUrl;
              if (complete) complete();
            })
            .catch(uploadError => {
              if (error) error(uploadError);
            });
        }
      }, 100);
    }
  };
  return uploadTask;
}

export function getDownloadURL(refObj: any) {
  if (!refObj.downloadUrl) {
    return Promise.reject(new Error('No uploaded image exists for this storage reference.'));
  }
  return Promise.resolve(refObj.downloadUrl);
}

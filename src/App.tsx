import React, { useState, useEffect, Component } from 'react';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  onSnapshot, 
  orderBy, 
  Timestamp,
  doc,
  getDocFromServer
} from 'firebase/firestore';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  User
} from 'firebase/auth';
import { GoogleGenAI } from "@google/genai";
import { db, auth } from './firebase';
import { 
  Wrench, 
  History, 
  ClipboardList, 
  FileText, 
  Plus, 
  LogOut, 
  Search, 
  ChevronRight,
  Download,
  AlertCircle,
  Car,
  Loader2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { format } from 'date-fns';
import jsPDF from 'jspdf';
import 'jspdf-autotable';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

interface Vehicle {
  id: string;
  year: number;
  make: string;
  model: string;
  engine: string;
  ownerId: string;
}

interface MaintenanceLog {
  id: string;
  vehicleId: string;
  service: string;
  mileage: number;
  cost: string;
  date: any;
  ownerId: string;
}

interface DiagnosticTicket {
  id: string;
  vehicleId: string;
  vehicleName: string;
  codes: string;
  notes: string;
  diagnosis: string;
  date: any;
  ownerId: string;
}

// --- AI Service ---
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

const generateDiagnosis = async (vehicle: Vehicle, codes: string, notes: string) => {
  const prompt = `AuroraOS Master Mechanic. 
Vehicle: ${vehicle.year} ${vehicle.make} ${vehicle.model} (${vehicle.engine}). 
Codes: ${codes}. 
Tech Notes: ${notes}. 
Provide a professional diagnosis and circuit test path. 
Format the output clearly with sections for "Possible Causes", "Recommended Tests", and "Repair Strategy". 
Use plain text, no markdown bolding.`;

  const response = await genAI.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [{ parts: [{ text: prompt }] }],
  });

  return response.text || "No diagnosis generated.";
};

// --- PDF Generation ---
const exportToPDF = (ticket: DiagnosticTicket) => {
  const doc = new jsPDF();

  // Header
  doc.setFontSize(18);
  doc.setTextColor(77, 168, 218); // #4DA8DA
  doc.text('REPAIR SOL2 - DIAGNOSTIC SHOP TICKET', 105, 20, { align: 'center' });

  doc.setDrawColor(0, 0, 0);
  doc.line(10, 25, 200, 25);

  // Content
  doc.setFontSize(12);
  doc.setTextColor(0, 0, 0);
  doc.text(`Date: ${format(ticket.date.toDate(), 'PPP')}`, 10, 35);
  doc.text(`Vehicle: ${ticket.vehicleName}`, 10, 45);
  doc.text(`DTCs/Symptoms: ${ticket.codes || 'None'}`, 10, 55);

  doc.setFontSize(14);
  doc.text('Diagnosis & Test Path:', 10, 70);

  doc.setFontSize(10);
  const splitText = doc.splitTextToSize(ticket.diagnosis, 180);
  doc.text(splitText, 10, 80);

  doc.save(`Ticket_${ticket.vehicleName.replace(/\s+/g, '_')}_${Date.now()}.pdf`);
};

class ErrorBoundary extends Component<{ children: React.ReactNode }, { hasError: boolean, error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-[#121212] text-white flex items-center justify-center p-6">
          <div className="bg-[#1e1e1e] p-8 rounded-2xl border border-red-500/20 max-w-md w-full text-center">
            <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
            <h1 className="text-xl font-bold mb-2">Something went wrong</h1>
            <p className="text-gray-400 mb-6">
              {this.state.error?.message.startsWith('{') 
                ? "A database error occurred. Please check your permissions." 
                : this.state.error?.message || "An unexpected error occurred."}
            </p>
            <button 
              onClick={() => window.location.reload()}
              className="bg-white text-black px-6 py-2 rounded-full font-bold hover:bg-gray-200 transition-all"
            >
              Reload App
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

// --- Components ---
export default function App() {
  return (
    <ErrorBoundary>
      <AppContent />
    </ErrorBoundary>
  );
}

function AppContent() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [activeTab, setActiveTab] = useState('diag');
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [maintLogs, setMaintLogs] = useState<MaintenanceLog[]>([]);
  const [tickets, setTickets] = useState<DiagnosticTicket[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form States
  const [diagForm, setDiagForm] = useState({ vehicleId: '', codes: '', notes: '' });
  const [maintForm, setMaintForm] = useState({ vehicleId: '', service: '', mileage: '', cost: '' });
  const [vehicleForm, setVehicleForm] = useState({ year: '', make: '', model: '', engine: '' });

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
      if (currentUser) {
        testConnection();
      }
    });
    return () => unsubscribe();
  }, []);

  const testConnection = async () => {
    try {
      await getDocFromServer(doc(db, 'test', 'connection'));
      console.log("Firebase connection successful");
    } catch (err: any) {
      console.error("Firebase connection test failed:", err);
      if (err.message?.includes('the client is offline')) {
        setError("Firebase is offline. Please check your internet connection or Firebase configuration.");
      } else if (err.code === 'permission-denied') {
        // This is expected if the test/connection doc doesn't exist but rules allow read
        console.log("Firebase connected (permission check passed)");
      } else {
        setError(`Firebase connection error: ${err.message}`);
      }
    }
  };

  useEffect(() => {
    if (!user || !isAuthReady) return;

    const vQuery = query(collection(db, 'vehicles'), where('ownerId', '==', user.uid));
    const mQuery = query(collection(db, 'maintenance'), where('ownerId', '==', user.uid), orderBy('date', 'desc'));
    const tQuery = query(collection(db, 'tickets'), where('ownerId', '==', user.uid), orderBy('date', 'desc'));

    const unsubV = onSnapshot(vQuery, (snap) => {
      setVehicles(snap.docs.map(d => ({ id: d.id, ...d.data() } as Vehicle)));
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'vehicles'));

    const unsubM = onSnapshot(mQuery, (snap) => {
      setMaintLogs(snap.docs.map(d => ({ id: d.id, ...d.data() } as MaintenanceLog)));
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'maintenance'));

    const unsubT = onSnapshot(tQuery, (snap) => {
      setTickets(snap.docs.map(d => ({ id: d.id, ...d.data() } as DiagnosticTicket)));
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'tickets'));

    return () => { unsubV(); unsubM(); unsubT(); };
  }, [user]);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error(err);
    }
  };

  const handleLogout = () => signOut(auth);

  const handleAddVehicle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const path = 'vehicles';
    try {
      await addDoc(collection(db, path), {
        ...vehicleForm,
        year: parseInt(vehicleForm.year),
        ownerId: user.uid,
        createdAt: Timestamp.now()
      });
      setVehicleForm({ year: '', make: '', model: '', engine: '' });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  const handleAddLog = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    const path = 'maintenance';
    try {
      await addDoc(collection(db, path), {
        ...maintForm,
        mileage: parseInt(maintForm.mileage),
        ownerId: user.uid,
        date: Timestamp.now()
      });
      setMaintForm({ vehicleId: '', service: '', mileage: '', cost: '' });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  };

  const handleGenerateTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user || !diagForm.vehicleId) return;
    setLoading(true);
    setError(null);
    const path = 'tickets';
    try {
      const vehicle = vehicles.find(v => v.id === diagForm.vehicleId);
      if (!vehicle) throw new Error("Vehicle not found");

      const diagnosis = await generateDiagnosis(vehicle, diagForm.codes, diagForm.notes);

      const ticketData = {
        vehicleId: vehicle.id,
        vehicleName: `${vehicle.year} ${vehicle.make} ${vehicle.model}`,
        codes: diagForm.codes,
        notes: diagForm.notes,
        diagnosis,
        date: Timestamp.now(),
        ownerId: user.uid
      };

      const docRef = await addDoc(collection(db, path), ticketData);
      setDiagForm({ vehicleId: '', codes: '', notes: '' });
      setActiveTab('history');

      // Auto-export the new ticket
      exportToPDF({ id: docRef.id, ...ticketData });
    } catch (err: any) {
      if (err.message && err.message.startsWith('{')) {
        setError("Permission denied. Database rules may be too restrictive.");
      } else {
        setError(err.message);
      }
      handleFirestoreError(err, OperationType.CREATE, path);
    } finally {
      setLoading(false);
    }
  };

  if (!isAuthReady) {
    return (
      <div className="min-h-screen bg-[#121212] flex items-center justify-center">
        <Loader2 className="w-10 h-10 text-[#4DA8DA] animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#121212] flex items-center justify-center p-4">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="max-w-md w-full bg-[#1e1e1e] p-8 rounded-2xl shadow-2xl text-center border border-white/5"
        >
          <div className="w-20 h-20 bg-[#4DA8DA]/10 rounded-full flex items-center justify-center mx-auto mb-6">
            <Wrench className="w-10 h-10 text-[#4DA8DA]" />
          </div>
          <h1 className="text-3xl font-bold text-white mb-2">Repair Sol2</h1>
          <p className="text-gray-400 mb-8">AI-Powered Diagnostic Shop Tickets</p>
          <button 
            onClick={handleLogin}
            className="w-full bg-[#4DA8DA] hover:bg-[#3d8cb8] text-black font-bold py-4 rounded-xl transition-all flex items-center justify-center gap-3"
          >
            <img src="https://www.google.com/favicon.ico" className="w-5 h-5" alt="Google" />
            Sign in with Google
          </button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#121212] text-white font-sans pb-20">
      {/* Header */}
      <header className="bg-[#1e1e1e] border-b border-white/5 sticky top-0 z-50">
        <div className="max-w-2xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Wrench className="text-[#4DA8DA] w-6 h-6" />
            <h1 className="text-xl font-bold tracking-tight">Repair Sol2</h1>
          </div>
          <button onClick={handleLogout} className="text-gray-400 hover:text-white transition-colors">
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6">
        {error && (
          <div className="mb-6 p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3 text-red-400">
            <AlertCircle className="w-5 h-5 shrink-0" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        {/* Tabs */}
        <div className="flex overflow-x-auto gap-2 mb-8 no-scrollbar">
          {[
            { id: 'diag', label: 'Diagnostics', icon: Wrench },
            { id: 'history', label: 'History', icon: History },
            { id: 'maint', label: 'Maintenance', icon: ClipboardList },
            { id: 'ref', label: 'Fleet', icon: Car },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-6 py-3 rounded-full whitespace-nowrap transition-all ${
                activeTab === tab.id 
                ? 'bg-[#4DA8DA] text-black font-bold' 
                : 'bg-[#1e1e1e] text-gray-400 hover:bg-[#252525]'
              }`}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait">
          {activeTab === 'diag' && (
            <motion.div
              key="diag"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-6"
            >
              <div className="bg-[#1e1e1e] p-6 rounded-2xl border border-white/5">
                <h2 className="text-lg font-bold text-[#4DA8DA] mb-6 flex items-center gap-2">
                  <Wrench className="w-5 h-5" />
                  New Diagnostic Ticket
                </h2>
                <form onSubmit={handleGenerateTicket} className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-2">Select Vehicle</label>
                    <select 
                      required
                      value={diagForm.vehicleId}
                      onChange={(e) => setDiagForm({ ...diagForm, vehicleId: e.target.value })}
                      className="w-full bg-[#2a2a2a] border border-white/5 rounded-xl px-4 py-3 focus:ring-2 focus:ring-[#4DA8DA] outline-none"
                    >
                      <option value="">Choose a vehicle...</option>
                      {vehicles.map(v => (
                        <option key={v.id} value={v.id}>{v.year} {v.make} {v.model}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-2">DTCs / Symptoms</label>
                    <input 
                      type="text"
                      placeholder="e.g., P0449, Parasitic drain"
                      value={diagForm.codes}
                      onChange={(e) => setDiagForm({ ...diagForm, codes: e.target.value })}
                      className="w-full bg-[#2a2a2a] border border-white/5 rounded-xl px-4 py-3 focus:ring-2 focus:ring-[#4DA8DA] outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-gray-400 mb-2">Tech Notes</label>
                    <textarea 
                      rows={4}
                      placeholder="Live multimeter readings, visual inspection notes..."
                      value={diagForm.notes}
                      onChange={(e) => setDiagForm({ ...diagForm, notes: e.target.value })}
                      className="w-full bg-[#2a2a2a] border border-white/5 rounded-xl px-4 py-3 focus:ring-2 focus:ring-[#4DA8DA] outline-none resize-none"
                    />
                  </div>
                  <button 
                    type="submit"
                    disabled={loading || !diagForm.vehicleId}
                    className="w-full bg-[#4DA8DA] disabled:opacity-50 disabled:cursor-not-allowed text-black font-bold py-4 rounded-xl hover:bg-[#3d8cb8] transition-all flex items-center justify-center gap-2"
                  >
                    {loading ? <Loader2 className="w-5 h-5 animate-spin" /> : <FileText className="w-5 h-5" />}
                    {loading ? 'Analyzing with AI...' : 'Generate AI Ticket'}
                  </button>
                </form>
              </div>
            </motion.div>
          )}

          {activeTab === 'history' && (
            <motion.div
              key="history"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-4"
            >
              <h2 className="text-lg font-bold text-[#4DA8DA] mb-4">Solution History</h2>
              {tickets.length === 0 ? (
                <div className="text-center py-12 bg-[#1e1e1e] rounded-2xl border border-dashed border-white/10">
                  <History className="w-12 h-12 text-gray-600 mx-auto mb-4" />
                  <p className="text-gray-500">No diagnostic tickets yet.</p>
                </div>
              ) : (
                tickets.map((ticket) => (
                  <div key={ticket.id} className="bg-[#1e1e1e] p-5 rounded-2xl border border-white/5 hover:border-[#4DA8DA]/30 transition-all group">
                    <div className="flex justify-between items-start mb-3">
                      <div>
                        <h3 className="font-bold text-white group-hover:text-[#4DA8DA] transition-colors">{ticket.vehicleName}</h3>
                        <p className="text-xs text-gray-500">{format(ticket.date.toDate(), 'PPP')}</p>
                      </div>
                      <button 
                        onClick={() => exportToPDF(ticket)}
                        className="p-2 bg-[#2a2a2a] rounded-lg text-[#4DA8DA] hover:bg-[#4DA8DA] hover:text-black transition-all"
                      >
                        <Download className="w-4 h-4" />
                      </button>
                    </div>
                    <div className="space-y-3">
                      <div className="text-xs">
                        <span className="text-[#4DA8DA] font-bold mr-2">CODES:</span>
                        <span className="text-gray-300 break-words">{ticket.codes || 'None'}</span>
                      </div>
                      <div className="text-sm text-gray-400 italic whitespace-pre-wrap break-words border-t border-white/5 pt-2">
                        {ticket.diagnosis}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </motion.div>
          )}

          {activeTab === 'maint' && (
            <motion.div
              key="maint"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-8"
            >
              <div className="bg-[#1e1e1e] p-6 rounded-2xl border border-white/5">
                <h2 className="text-lg font-bold text-[#A5D6A7] mb-6 flex items-center gap-2">
                  <ClipboardList className="w-5 h-5" />
                  Log Maintenance
                </h2>
                <form onSubmit={handleAddLog} className="space-y-4">
                  <select 
                    required
                    value={maintForm.vehicleId}
                    onChange={(e) => setMaintForm({ ...maintForm, vehicleId: e.target.value })}
                    className="w-full bg-[#2a2a2a] border border-white/5 rounded-xl px-4 py-3 focus:ring-2 focus:ring-[#A5D6A7] outline-none"
                  >
                    <option value="">Select Vehicle...</option>
                    {vehicles.map(v => (
                      <option key={v.id} value={v.id}>{v.year} {v.make} {v.model}</option>
                    ))}
                  </select>
                  <input 
                    required
                    type="text"
                    placeholder="Service (e.g., Oil Change)"
                    value={maintForm.service}
                    onChange={(e) => setMaintForm({ ...maintForm, service: e.target.value })}
                    className="w-full bg-[#2a2a2a] border border-white/5 rounded-xl px-4 py-3 focus:ring-2 focus:ring-[#A5D6A7] outline-none"
                  />
                  <div className="grid grid-cols-2 gap-4">
                    <input 
                      required
                      type="number"
                      placeholder="Mileage"
                      value={maintForm.mileage}
                      onChange={(e) => setMaintForm({ ...maintForm, mileage: e.target.value })}
                      className="w-full bg-[#2a2a2a] border border-white/5 rounded-xl px-4 py-3 focus:ring-2 focus:ring-[#A5D6A7] outline-none"
                    />
                    <input 
                      type="text"
                      placeholder="Cost (Optional)"
                      value={maintForm.cost}
                      onChange={(e) => setMaintForm({ ...maintForm, cost: e.target.value })}
                      className="w-full bg-[#2a2a2a] border border-white/5 rounded-xl px-4 py-3 focus:ring-2 focus:ring-[#A5D6A7] outline-none"
                    />
                  </div>
                  <button 
                    type="submit"
                    className="w-full bg-[#A5D6A7] text-black font-bold py-4 rounded-xl hover:bg-[#8bc38f] transition-all"
                  >
                    Log Service
                  </button>
                </form>
              </div>

              <div className="space-y-4">
                <h3 className="text-lg font-bold text-[#A5D6A7]">Recent Logs</h3>
                {maintLogs.length === 0 ? (
                  <p className="text-gray-500 text-center py-8">No maintenance logs found.</p>
                ) : (
                  maintLogs.map((log) => {
                    const vehicle = vehicles.find(v => v.id === log.vehicleId);
                    return (
                      <div key={log.id} className="bg-[#1e1e1e] p-4 rounded-xl border border-white/5 flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-xs text-[#A5D6A7] font-bold uppercase tracking-wider truncate">
                            {vehicle ? `${vehicle.year} ${vehicle.make}` : 'Unknown Vehicle'}
                          </p>
                          <h4 className="font-bold text-white break-words">{log.service}</h4>
                          <p className="text-xs text-gray-500">{format(log.date.toDate(), 'PPP')}</p>
                        </div>
                        <div className="text-right flex-shrink-0">
                          <p className="font-mono text-sm">{log.mileage.toLocaleString()} mi</p>
                          {log.cost && <p className="text-xs text-gray-400">${log.cost}</p>}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </motion.div>
          )}

          {activeTab === 'ref' && (
            <motion.div
              key="ref"
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              className="space-y-8"
            >
              <div className="bg-[#1e1e1e] p-6 rounded-2xl border border-white/5">
                <h2 className="text-lg font-bold text-[#4DA8DA] mb-6 flex items-center gap-2">
                  <Plus className="w-5 h-5" />
                  Add New Vehicle
                </h2>
                <form onSubmit={handleAddVehicle} className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <input 
                      required
                      type="number"
                      placeholder="Year"
                      value={vehicleForm.year}
                      onChange={(e) => setVehicleForm({ ...vehicleForm, year: e.target.value })}
                      className="w-full bg-[#2a2a2a] border border-white/5 rounded-xl px-4 py-3 focus:ring-2 focus:ring-[#4DA8DA] outline-none"
                    />
                    <input 
                      required
                      type="text"
                      placeholder="Make"
                      value={vehicleForm.make}
                      onChange={(e) => setVehicleForm({ ...vehicleForm, make: e.target.value })}
                      className="w-full bg-[#2a2a2a] border border-white/5 rounded-xl px-4 py-3 focus:ring-2 focus:ring-[#4DA8DA] outline-none"
                    />
                  </div>
                  <input 
                    required
                    type="text"
                    placeholder="Model"
                    value={vehicleForm.model}
                    onChange={(e) => setVehicleForm({ ...vehicleForm, model: e.target.value })}
                    className="w-full bg-[#2a2a2a] border border-white/5 rounded-xl px-4 py-3 focus:ring-2 focus:ring-[#4DA8DA] outline-none"
                  />
                  <input 
                    required
                    type="text"
                    placeholder="Engine (e.g., 3.8L V6)"
                    value={vehicleForm.engine}
                    onChange={(e) => setVehicleForm({ ...vehicleForm, engine: e.target.value })}
                    className="w-full bg-[#2a2a2a] border border-white/5 rounded-xl px-4 py-3 focus:ring-2 focus:ring-[#4DA8DA] outline-none"
                  />
                  <button 
                    type="submit"
                    className="w-full bg-[#4DA8DA] text-black font-bold py-4 rounded-xl hover:bg-[#3d8cb8] transition-all"
                  >
                    Save Vehicle
                  </button>
                </form>
              </div>

              <div className="space-y-4">
                <h3 className="text-lg font-bold text-[#4DA8DA]">Your Fleet</h3>
                {vehicles.length === 0 ? (
                  <p className="text-gray-500 text-center py-8">No vehicles added yet.</p>
                ) : (
                  <div className="grid grid-cols-1 gap-4">
                    {vehicles.map((v) => (
                      <div key={v.id} className="bg-[#1e1e1e] p-5 rounded-2xl border border-white/5 flex items-center gap-4 min-w-0">
                        <div className="w-12 h-12 bg-[#2a2a2a] rounded-xl flex-shrink-0 flex items-center justify-center text-[#4DA8DA]">
                          <Car className="w-6 h-6" />
                        </div>
                        <div className="min-w-0">
                          <h4 className="font-bold text-white truncate">{v.year} {v.make} {v.model}</h4>
                          <p className="text-xs text-gray-500 truncate">{v.engine}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

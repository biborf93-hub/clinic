import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenAI } from '@google/genai';

const app = express();
const PORT = 3000;

app.use(express.json());

// Lazy-initialization helpers to prevent crashes if environment variables are missing on startup
function getSupabaseAdmin() {
  let url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) {
    throw new Error('Supabase URL or Service Role Key is missing. Please configure them in Settings -> Secrets.');
  }

  // Clean and sanitize SUPABASE_URL: extract only the base origin (e.g. https://xxx.supabase.co) and discard subpaths
  try {
    const parsedUrl = new URL(url.trim());
    url = parsedUrl.origin;
  } catch (err) {
    url = url.trim().replace(/\/+$/, '');
    if (url.endsWith('/auth/v1')) {
      url = url.substring(0, url.length - 8);
    } else if (url.endsWith('/auth')) {
      url = url.substring(0, url.length - 5);
    } else if (url.endsWith('/rest/v1')) {
      url = url.substring(0, url.length - 8);
    }
    url = url.replace(/\/+$/, '');
  }

  console.log('[SUPABASE INIT] Creating a fresh admin client with sanitized URL:', url);

  // Return a fresh client instance every time to prevent header/session pollution across requests
  return createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

// Initialize Gemini SDK with custom user agent for AI Studio telemetry
let geminiInstance: any = null;

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is missing. Please configure it in Settings -> Secrets.');
  }
  if (!geminiInstance) {
    geminiInstance = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return geminiInstance;
}

// Function to auto-seed a default doctor and standard clinic availability
async function seedDoctorAndSchedule() {
  try {
    const adminClient = getSupabaseAdmin();
    console.log('Checking doctor table/auth configuration...');

    // We fetch users through Auth Admin API to check if doctor exists
    const { data: { users }, error: listError } = await adminClient.auth.admin.listUsers();
    if (listError) {
      console.warn('Could not list users for seeding (might be table schema/RLS setup issue):', listError.message);
      return;
    }

    const doctorEmail = 'doctor@clinic.com';
    const adminEmail = 'admin@clinic.com';
    const doctorExists = users.some((u: any) => u.email === doctorEmail);
    const adminExists = users.some((u: any) => u.email === adminEmail);

    let doctorId = '';
    if (!doctorExists) {
      console.log(`Seeding default doctor account (${doctorEmail})...`);
      const { data: user, error: createError } = await adminClient.auth.admin.createUser({
        email: doctorEmail,
        password: 'DoctorPassword123!',
        email_confirm: true,
        app_metadata: { role: 'doctor' },
        user_metadata: { full_name: 'Dr. Sarah Jenkins' }
      });

      if (createError) {
        console.error('Error seeding doctor account:', createError.message);
      } else if (user && user.user) {
        doctorId = user.user.id;
        console.log('Doctor account seeded successfully:', doctorEmail);
      }
    } else {
      const docUser = users.find((u: any) => u.email === doctorEmail);
      doctorId = docUser.id;
      console.log('Doctor account already exists.');
    }

    if (!adminExists) {
      console.log(`Seeding default super admin account (${adminEmail})...`);
      const { data: user, error: createError } = await adminClient.auth.admin.createUser({
        email: adminEmail,
        password: 'AdminPassword123!',
        email_confirm: true,
        app_metadata: { role: 'super_admin' },
        user_metadata: { full_name: 'System Administrator' }
      });

      if (createError) {
        console.error('Error seeding super admin account:', createError.message);
      } else if (user && user.user) {
        console.log('Super Admin account seeded successfully:', adminEmail);
      }
    } else {
      console.log('Super Admin account already exists.');
    }

    // Check if service catalog needs seeding
    try {
      const { data: services, error: getSvcError } = await adminClient
        .from('service_catalog')
        .select('*');
      
      if (!getSvcError && (!services || services.length === 0)) {
        console.log('Seeding default service catalog...');
        const defaultServices = [
          { visit_type: 'Emergency Care', name: 'Emergency Care', default_price: 150, description: 'Immediate urgent attention' },
          { visit_type: 'General Consultation', name: 'General Consultation', default_price: 80, description: 'Standard health checkup' },
          { visit_type: 'Follow-up', name: 'Follow-up', default_price: 50, description: 'Reviewing progress or results' },
        ];
        const { error: seedSvcError } = await adminClient.from('service_catalog').insert(defaultServices);
        if (seedSvcError) {
          console.error('Error seeding default services:', seedSvcError.message);
        } else {
          console.log('Service catalog seeded successfully!');
        }
      } else if (getSvcError) {
        console.warn('Could not query service_catalog for seeding (SQL table may not be initialized yet):', getSvcError.message);
      }
    } catch (e: any) {
      console.warn('Could not check or seed service catalog:', e.message);
    }

    // Check if availability schedule needs seeding
    const { data: availability, error: getAvailError } = await adminClient
      .from('doctor_availability')
      .select('*');

    if (getAvailError) {
      console.warn('Could not fetch doctor availability for seeding (SQL schema may not be created yet):', getAvailError.message);
      return;
    }

    if (!availability || availability.length === 0) {
      console.log('Seeding default doctor availability (Monday-Friday 9 AM - 5 PM)...');
      const defaultSlots = [];
      for (let day = 1; day <= 5; day++) {
        defaultSlots.push({
          day_of_week: day,
          start_time: '09:00:00',
          end_time: '17:00:00',
          is_available: true,
        });
      }
      // Saturday 9 AM - 2 PM
      defaultSlots.push({
        day_of_week: 6,
        start_time: '09:00:00',
        end_time: '14:00:00',
        is_available: true,
      });

      const { error: seedError } = await adminClient
        .from('doctor_availability')
        .insert(defaultSlots);

      if (seedError) {
        console.error('Error seeding default slots:', seedError.message);
      } else {
        console.log('Default availability seeded successfully!');
      }
    }
  } catch (err: any) {
    console.warn('Seed process was bypassed (DB is not fully initialized or credentials are missing). This is expected if the Supabase tables/triggers have not been set up in the dashboard yet.', err.message);
  }
}

// Run seeding asynchronously on startup (won't block server listening)
setTimeout(() => {
  seedDoctorAndSchedule().catch((err) => console.error('Seeding error:', err));
}, 5000);

// Helper to authenticate request and extract user context
async function authenticateUser(req: express.Request) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Unauthorized: Missing or invalid authorization token.');
  }
  const token = authHeader.split(' ')[1];
  const adminClient = getSupabaseAdmin();
  const { data: { user }, error } = await adminClient.auth.getUser(token);
  if (error || !user) {
    throw new Error('Unauthorized: Invalid credentials or expired session.');
  }
  return user;
}

// API: Config check endpoint
app.get('/api/config-check', (req, res) => {
  const missing = [];
  if (!process.env.SUPABASE_URL) missing.push('SUPABASE_URL');
  if (!process.env.SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY');
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!process.env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');

  res.json({
    configured: missing.length === 0,
    missing,
  });
});

// API: Trigger seeding manually
app.post('/api/seed-doctor', async (req, res) => {
  try {
    await seedDoctorAndSchedule();
    res.json({ success: true, message: 'Doctor seeding completed or checked.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: Sign Up Endpoint
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, full_name, phone, date_of_birth, redirectTo } = req.body;
    if (!email || !password || !full_name || !phone || !date_of_birth) {
      return res.status(400).json({ error: 'All fields (Email, Password, Full Name, Phone, Date of Birth) are required.' });
    }

    const adminClient = getSupabaseAdmin();

    if (redirectTo) {
      console.log('[SUPABASE AUTH] signUp redirectTo URL:', redirectTo);
    } else {
      console.log('[SUPABASE AUTH] signUp: Relying on default Supabase Site URL (no redirectTo passed).');
    }

    // 1. Create User in Supabase Auth
    console.log('Signing up user via Supabase Auth...');
    const { data: createData, error: createError } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: { role: 'patient' },
      user_metadata: { full_name, phone },
    });

    if (createError) {
      console.error('Auth signup error:', createError.message);
      return res.status(400).json({ error: createError.message });
    }

    const user = createData.user;
    if (!user) {
      return res.status(500).json({ error: 'Auth signup failed to return user data.' });
    }

    // 2. Insert into Patients table
    console.log('Adding patient record to database...', user.id);
    const { error: dbError } = await adminClient
      .from('patients')
      .insert({
        id: user.id,
        email,
        full_name,
        phone,
        date_of_birth,
      });

    if (dbError) {
      console.error('Database write error during patient creation:', dbError.message);
      // Clean up user in auth table if database registration failed
      await adminClient.auth.admin.deleteUser(user.id);
      return res.status(400).json({
        error: `Failed to create patient record: ${dbError.message}. Please verify if you have created the tables in Supabase SQL editor (see schema instructions).`,
      });
    }

    // 3. Perform a login using credentials to supply an access token immediately
    const { data: sessionData, error: loginError } = await adminClient.auth.signInWithPassword({
      email,
      password,
    });

    if (loginError) {
      return res.json({
        success: true,
        message: 'Account created, but automatic sign-in failed. Please log in manually.',
        user,
      });
    }

    res.json({
      success: true,
      session: sessionData.session,
      user: sessionData.user,
      role: 'patient',
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: Login Endpoint
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, redirectTo } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const adminClient = getSupabaseAdmin();

    if (redirectTo) {
      console.log('[SUPABASE AUTH] signIn redirectTo URL:', redirectTo);
    } else {
      console.log('[SUPABASE AUTH] signIn: Relying on default Supabase Site URL (no redirectTo passed).');
    }

    const { data, error } = await adminClient.auth.signInWithPassword({
      email,
      password,
    });

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const user = data.user;
    const role = user?.app_metadata?.role || 'patient';

    let patientProfile = null;
    if (role === 'patient') {
      const { data: patient, error: patientError } = await adminClient
        .from('patients')
        .select('*')
        .eq('id', user.id)
        .single();

      if (!patientError && patient) {
        patientProfile = patient;
      }
    }

    res.json({
      success: true,
      session: data.session,
      user,
      role,
      patient: patientProfile,
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: OAuth Endpoint (Proxy)
app.post('/api/auth/oauth', async (req, res) => {
  try {
    const { provider, origin } = req.body;
    if (!provider) {
      return res.status(400).json({ error: 'OAuth provider is required.' });
    }

    const adminClient = getSupabaseAdmin();
    
    // Generate absolute redirectTo URL using client's origin dynamically
    const clientOrigin = origin || `${req.protocol}://${req.get('host')}`;
    const redirectTo = `${clientOrigin.replace(/\/+$/, '')}/dashboard`;

    console.log(`[SUPABASE AUTH] redirectTo URL being sent for signInWithOAuth (${provider}):`, redirectTo);

    const { data, error } = await adminClient.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo,
      },
    });

    if (error) throw error;
    res.json({ success: true, url: data.url });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: Reset Password Endpoint (Proxy)
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { email, origin } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const adminClient = getSupabaseAdmin();
    
    // Generate absolute redirectTo URL using client's origin dynamically
    const clientOrigin = origin || `${req.protocol}://${req.get('host')}`;
    const redirectTo = `${clientOrigin.replace(/\/+$/, '')}/reset-password-callback`;

    console.log('[SUPABASE AUTH] redirectTo URL being sent for resetPassword:', redirectTo);

    const { error } = await adminClient.auth.resetPasswordForEmail(email, {
      redirectTo,
    });

    if (error) throw error;
    res.json({ success: true, message: 'Password reset instructions sent.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: Get Current Session / Me
app.get('/api/auth/me', async (req, res) => {
  try {
    const user = await authenticateUser(req);
    const role = user.app_metadata?.role || 'patient';
    const adminClient = getSupabaseAdmin();

    let patientProfile = null;
    if (role === 'patient') {
      const { data: patient } = await adminClient
        .from('patients')
        .select('*')
        .eq('id', user.id)
        .single();
      patientProfile = patient;
    }

    res.json({
      success: true,
      user,
      role,
      patient: patientProfile,
    });
  } catch (err: any) {
    res.status(401).json({ error: err.message });
  }
});

// API: Get Appointments (Doctor/SuperAdmin: all, Patient: own)
app.get('/api/appointments', async (req, res) => {
  try {
    const user = await authenticateUser(req);
    const role = user.app_metadata?.role || 'patient';
    const adminClient = getSupabaseAdmin();

    if (role === 'doctor' || role === 'super_admin') {
      // Return ALL appointments joined with patient data
      const { data, error } = await adminClient
        .from('appointments')
        .select('*, patients (full_name, email, phone)')
        .order('appointment_date', { ascending: true });

      if (error) throw error;
      res.json(data || []);
    } else {
      // Return patient's own appointments
      const { data, error } = await adminClient
        .from('appointments')
        .select('*')
        .eq('patient_id', user.id)
        .order('appointment_date', { ascending: true });

      if (error) throw error;
      res.json(data || []);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: Book Appointment
app.post('/api/appointments', async (req, res) => {
  try {
    const user = await authenticateUser(req);
    const { appointment_date, notes, visit_type } = req.body;

    if (!appointment_date) {
      return res.status(400).json({ error: 'Appointment date and time are required.' });
    }

    const adminClient = getSupabaseAdmin();

    // Patients book with their own ID. If doctor/admin is booking on behalf, support that too or default to actor.
    const role = user.app_metadata?.role || 'patient';
    let patientId = user.id;

    if ((role === 'doctor' || role === 'super_admin') && req.body.patient_id) {
      patientId = req.body.patient_id;
    }

    // Fetch default price from service_catalog based on selected visit_type
    const selectedVisitType = visit_type || 'General Consultation';
    let price = 0;
    try {
      const { data: service } = await adminClient
        .from('service_catalog')
        .select('default_price')
        .eq('visit_type', selectedVisitType)
        .single();
      if (service) {
        price = Number(service.default_price);
      } else {
        // Fallback pricing if not seeded/found
        if (selectedVisitType === 'Emergency Care') price = 150;
        else if (selectedVisitType === 'General Consultation') price = 80;
        else if (selectedVisitType === 'Follow-up') price = 50;
      }
    } catch (err) {
      console.warn('Fallback pricing used for visit_type:', selectedVisitType);
      if (selectedVisitType === 'Emergency Care') price = 150;
      else if (selectedVisitType === 'General Consultation') price = 80;
      else if (selectedVisitType === 'Follow-up') price = 50;
    }

    const { data, error } = await adminClient
      .from('appointments')
      .insert({
        patient_id: patientId,
        appointment_date,
        status: 'pending',
        notes: notes || '',
        visit_type: selectedVisitType,
        price: price,
        show_price_to_patient: false // Defaults to false, managed by Super Admin
      })
      .select()
      .single();

    if (error) {
      console.error('Booking insert error:', error.message);
      throw error;
    }

    res.json({ success: true, appointment: data });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: Update Appointment (Doctor can do clinical completion, Super Admin has full control, Patient can cancel)
app.patch('/api/appointments/:id', async (req, res) => {
  try {
    const user = await authenticateUser(req);
    const { id } = req.params;
    const { 
      status, 
      appointment_date, 
      notes, 
      doctor_notes, 
      prescribed_medicines, 
      price, 
      show_price_to_patient,
      visit_type
    } = req.body;

    const role = user.app_metadata?.role || 'patient';
    const adminClient = getSupabaseAdmin();

    // 1. Fetch appointment first
    const { data: appointment, error: fetchError } = await adminClient
      .from('appointments')
      .select('*')
      .eq('id', id)
      .single();

    if (fetchError || !appointment) {
      return res.status(404).json({ error: 'Appointment not found.' });
    }

    const isOwner = appointment.patient_id === user.id;

    // 2. Validate update authorization
    if (role === 'doctor') {
      // Doctor can update status, notes, clinical notes, prescribed medicines
      const updateData: any = {};
      if (status) {
        updateData.status = status;
        if (status === 'completed') {
          updateData.completed_at = new Date().toISOString();
        }
      }
      if (appointment_date) updateData.appointment_date = appointment_date;
      if (notes !== undefined) updateData.notes = notes;
      if (doctor_notes !== undefined) updateData.doctor_notes = doctor_notes;
      if (prescribed_medicines !== undefined) updateData.prescribed_medicines = prescribed_medicines;
      updateData.updated_at = new Date().toISOString();

      const { data: updated, error: updateError } = await adminClient
        .from('appointments')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();

      if (updateError) throw updateError;
      return res.json({ success: true, appointment: updated });
    } else if (role === 'super_admin') {
      // Super Admin has full pricing and configuration control
      const updateData: any = {};
      if (status) {
        updateData.status = status;
        if (status === 'completed' && !appointment.completed_at) {
          updateData.completed_at = new Date().toISOString();
        }
      }
      if (appointment_date) updateData.appointment_date = appointment_date;
      if (notes !== undefined) updateData.notes = notes;
      if (doctor_notes !== undefined) updateData.doctor_notes = doctor_notes;
      if (prescribed_medicines !== undefined) updateData.prescribed_medicines = prescribed_medicines;
      if (price !== undefined) updateData.price = Number(price);
      if (show_price_to_patient !== undefined) updateData.show_price_to_patient = Boolean(show_price_to_patient);
      if (visit_type !== undefined) updateData.visit_type = visit_type;
      updateData.updated_at = new Date().toISOString();

      const { data: updated, error: updateError } = await adminClient
        .from('appointments')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();

      if (updateError) throw updateError;
      return res.json({ success: true, appointment: updated });
    } else if (isOwner) {
      // Patient can ONLY cancel their own appointment
      if (status && status !== 'cancelled') {
        return res.status(403).json({ error: 'Patients can only update appointment status to cancelled.' });
      }

      const updateData: any = {};
      if (status) updateData.status = 'cancelled';
      if (notes !== undefined) updateData.notes = notes;
      updateData.updated_at = new Date().toISOString();

      const { data: updated, error: updateError } = await adminClient
        .from('appointments')
        .update(updateData)
        .eq('id', id)
        .select()
        .single();

      if (updateError) throw updateError;
      return res.json({ success: true, appointment: updated });
    } else {
      return res.status(403).json({ error: 'Unauthorized to modify this appointment.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: Delete Appointment (Doctor or Super Admin only)
app.delete('/api/appointments/:id', async (req, res) => {
  try {
    const user = await authenticateUser(req);
    const role = user.app_metadata?.role || 'patient';

    if (role !== 'doctor' && role !== 'super_admin') {
      return res.status(403).json({ error: 'Only administrators (doctors or super admins) can delete appointments.' });
    }

    const { id } = req.params;
    const adminClient = getSupabaseAdmin();

    const { error } = await adminClient
      .from('appointments')
      .delete()
      .eq('id', id);

    if (error) throw error;
    res.json({ success: true, message: 'Appointment deleted successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: Get Service Catalog (All authenticated roles can read)
app.get('/api/service-catalog', async (req, res) => {
  try {
    const adminClient = getSupabaseAdmin();
    const { data, error } = await adminClient
      .from('service_catalog')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      console.warn('Service catalog fetch error, returning custom in-memory fallback list:', error.message);
      return res.json([
        { visit_type: 'Emergency Care', name: 'Emergency Care', default_price: 150, description: 'Immediate urgent medical attention' },
        { visit_type: 'General Consultation', name: 'General Consultation', default_price: 80, description: 'Standard health checkup' },
        { visit_type: 'Follow-up', name: 'Follow-up', default_price: 50, description: 'Reviewing progress or test results' },
      ]);
    }
    res.json(data || []);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: Update Service Catalog defaults (Super Admin only)
app.patch('/api/service-catalog/:visit_type', async (req, res) => {
  try {
    const user = await authenticateUser(req);
    const role = user.app_metadata?.role || 'patient';
    if (role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied. Super Admin role required.' });
    }

    const { visit_type } = req.params;
    const { default_price, name, description } = req.body;
    const adminClient = getSupabaseAdmin();

    const updateData: any = {};
    if (default_price !== undefined) updateData.default_price = Number(default_price);
    if (name !== undefined) updateData.name = name;
    if (description !== undefined) updateData.description = description;

    // Check if entry exists
    const { data: existing, error: fetchError } = await adminClient
      .from('service_catalog')
      .select('*')
      .eq('visit_type', visit_type)
      .single();

    if (fetchError || !existing) {
      // Insert if missing
      const { data, error } = await adminClient
        .from('service_catalog')
        .insert({
          visit_type,
          name: name || visit_type,
          default_price: Number(default_price) || 0,
          description: description || ''
        })
        .select()
        .single();
      if (error) throw error;
      return res.json(data);
    } else {
      // Update existing
      const { data, error } = await adminClient
        .from('service_catalog')
        .update(updateData)
        .eq('visit_type', visit_type)
        .select()
        .single();
      if (error) throw error;
      return res.json(data);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: Get Financial Dashboard Stats (Super Admin only)
app.get('/api/admin/financial-stats', async (req, res) => {
  try {
    const user = await authenticateUser(req);
    const role = user.app_metadata?.role || 'patient';
    if (role !== 'super_admin') {
      return res.status(403).json({ error: 'Access denied. Super Admin role required.' });
    }

    const adminClient = getSupabaseAdmin();
    const { data: appointments, error } = await adminClient
      .from('appointments')
      .select('*');

    if (error) throw error;

    const appts = appointments || [];

    let totalRevenue = 0;
    const statusCounts = {
      pending: 0,
      confirmed: 0,
      completed: 0,
      cancelled: 0,
    };

    const breakdown: { [key: string]: number } = {
      'Emergency Care': 0,
      'General Consultation': 0,
      'Follow-up': 0,
    };

    let revenueToday = 0;
    let revenueThisWeek = 0;
    let revenueThisMonth = 0;

    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

    // Start of week (Sunday)
    const sunday = new Date(now);
    sunday.setDate(now.getDate() - now.getDay());
    sunday.setHours(0, 0, 0, 0);

    // Start of month
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    appts.forEach((appt: any) => {
      const status = appt.status as 'pending' | 'confirmed' | 'completed' | 'cancelled';
      if (statusCounts[status] !== undefined) {
        statusCounts[status]++;
      }

      if (status === 'completed') {
        const p = Number(appt.price) || 0;
        totalRevenue += p;

        const vt = appt.visit_type || 'General Consultation';
        if (breakdown[vt] !== undefined) {
          breakdown[vt] += p;
        } else {
          breakdown[vt] = p; // in case dynamic types are custom
        }

        const compDateStr = appt.completed_at || appt.appointment_date;
        if (compDateStr) {
          const compDate = new Date(compDateStr);
          const compDateISO = compDate.toISOString().slice(0, 10);

          if (compDateISO === todayStr) {
            revenueToday += p;
          }
          if (compDate >= sunday) {
            revenueThisWeek += p;
          }
          if (compDate >= startOfMonth) {
            revenueThisMonth += p;
          }
        }
      }
    });

    res.json({
      totalRevenue,
      statusCounts,
      breakdown,
      revenueRanges: {
        today: revenueToday,
        week: revenueThisWeek,
        month: revenueThisMonth,
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: Get Doctor Availability (Public & Patients)
app.get('/api/doctor/availability', async (req, res) => {
  try {
    const adminClient = getSupabaseAdmin();
    const { data, error } = await adminClient
      .from('doctor_availability')
      .select('*')
      .order('day_of_week', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: Bulk Save Doctor Availability (Doctor only)
app.put('/api/doctor/availability', async (req, res) => {
  try {
    const user = await authenticateUser(req);
    const role = user.app_metadata?.role || 'patient';

    if (role !== 'doctor') {
      return res.status(403).json({ error: 'Only doctor admins can modify availability schedule.' });
    }

    const { slots } = req.body; // Array of availability slots
    if (!Array.isArray(slots)) {
      return res.status(400).json({ error: 'Slots payload must be a valid array.' });
    }

    const adminClient = getSupabaseAdmin();

    // Clean out existing rows and bulk insert new ones
    const { error: deleteError } = await adminClient
      .from('doctor_availability')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000'); // Truncate check

    if (deleteError) throw deleteError;

    if (slots.length > 0) {
      const { data, error: insertError } = await adminClient
        .from('doctor_availability')
        .insert(slots.map((s: any) => ({
          day_of_week: parseInt(s.day_of_week),
          start_time: s.start_time,
          end_time: s.end_time,
          is_available: s.is_available ?? true,
        })))
        .select();

      if (insertError) throw insertError;
      return res.json({ success: true, slots: data });
    }

    res.json({ success: true, slots: [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: Get Doctor's Registered Patients List (Doctor only)
app.get('/api/doctor/patients', async (req, res) => {
  try {
    const user = await authenticateUser(req);
    const role = user.app_metadata?.role || 'patient';

    if (role !== 'doctor') {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const adminClient = getSupabaseAdmin();
    const { data, error } = await adminClient
      .from('patients')
      .select('*')
      .order('full_name', { ascending: true });

    if (error) throw error;
    res.json(data || []);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// API: Clinic AI Chatbot (Gemini Powered)
app.post('/api/chatbot', async (req, res) => {
  try {
    const { message, chatHistory } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Message content is required.' });
    }

    const ai = getGeminiClient();

    // Map chatHistory to Gemini API format if present
    const contents: any[] = [];
    if (Array.isArray(chatHistory)) {
      chatHistory.forEach((item: any) => {
        contents.push({
          role: item.sender === 'user' ? 'user' : 'model',
          parts: [{ text: item.text }],
        });
      });
    }

    // Append current message
    contents.push({
      role: 'user',
      parts: [{ text: message }],
    });

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents,
      config: {
        systemInstruction: `You are ClinicAI, the empathetic and professional virtual assistant for Pinecrest Medical Clinic.

PINE-CREST CLINIC DIRECTORY & CONTACTS:
- Name: Pinecrest Medical Clinic
- Address: 123 Health Ave, Suite 400, Medical District
- Telephone: (555) 019-2834
- Email: care@pinecrestclinic.com
- Hours of Operation:
  * Monday to Friday: 8:00 AM – 6:00 PM
  * Saturday: 9:00 AM – 2:00 PM
  * Sunday: Closed (For emergencies, please go to the nearest hospital)
- Head Physician: Dr. Sarah Jenkins (Specialist in Family Practice & Pediatric Care)
- Services offered: General diagnostics, seasonal flu vaccinations, health consultations, physical fitness assessments, pediatric checks, and prescriptions refills.

YOUR BEHAVIOR AND RULES:
1. Be extremely supportive, gentle, and medically responsible.
2. NEVER prescribe drugs, perform diagnosis, or simulate complex clinical judgements.
3. For any clinical complaints, suggest booking a formal consultation with Dr. Jenkins immediately.
4. If the patient wants to book an appointment, help them decide their preferred date and time, then kindly instruct them to use our online portal:
   * Tell them they must sign up or login on the top right navigation bar.
   * After logging in, they can access the "Book Appointment" tab to select their slot and submit.
5. Provide helpful and detailed answers. Keep them compact enough to read on an active chat drawer. Do not use markdown format heavily; use simple bullets.`,
      },
    });

    const botText = response.text || "I'm here to support you. Please contact our front desk at (555) 019-2834 for direct medical assistance.";
    res.json({ text: botText });
  } catch (err: any) {
    console.error('Gemini error:', err);
    res.status(500).json({ error: `ClinicAI currently resting: ${err.message}` });
  }
});

// Main Server Setup (Express + Vite)
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[SERVER] Ready & Listening on port ${PORT}`);
  });
}

startServer();

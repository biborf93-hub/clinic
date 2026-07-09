-- ==========================================
-- PINECREST CLINIC APPOINTMENT SYSTEM DATABASE SCHEMA
-- ==========================================
-- Paste this script directly into your Supabase SQL Editor (Dashboard -> SQL Editor)
-- to provision your tables, indexes, and RLS policies.

-- 1. Create Patients Table
CREATE TABLE IF NOT EXISTS public.patients (
    id UUID PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    phone TEXT NOT NULL,
    date_of_birth DATE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS for Patients Table
ALTER TABLE public.patients ENABLE ROW LEVEL SECURITY;

-- 2. Create Appointments Table
CREATE TABLE IF NOT EXISTS public.appointments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID NOT NULL REFERENCES public.patients(id) ON DELETE CASCADE,
    appointment_date TIMESTAMP WITH TIME ZONE NOT NULL,
    status TEXT DEFAULT 'pending'::text NOT NULL CHECK (status IN ('pending', 'confirmed', 'completed', 'cancelled')),
    notes TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS for Appointments Table
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;

-- 3. Create Doctor Availability Table
CREATE TABLE IF NOT EXISTS public.doctor_availability (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Sunday, 6=Saturday
    start_time TIME NOT NULL,
    end_time TIME NOT NULL,
    is_available BOOLEAN DEFAULT true NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS for Doctor Availability Table
ALTER TABLE public.doctor_availability ENABLE ROW LEVEL SECURITY;


-- ==========================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- ==========================================

-- A. Patients Table Policies
CREATE POLICY "Patients can select their own profile" 
ON public.patients FOR SELECT 
USING (auth.uid() = id);

CREATE POLICY "Patients can update their own profile" 
ON public.patients FOR UPDATE 
USING (auth.uid() = id);

-- Allow new patient registrations during sign up
CREATE POLICY "Enable registration insert for authenticated sign up" 
ON public.patients FOR INSERT 
WITH CHECK (true);

CREATE POLICY "Doctors can view all patients" 
ON public.patients FOR SELECT 
USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'doctor');


-- B. Appointments Table Policies
CREATE POLICY "Patients can view their own appointments" 
ON public.appointments FOR SELECT 
USING (auth.uid() = patient_id);

CREATE POLICY "Patients can create their own appointments" 
ON public.appointments FOR INSERT 
WITH CHECK (auth.uid() = patient_id);

CREATE POLICY "Patients can cancel their own appointments" 
ON public.appointments FOR UPDATE 
USING (auth.uid() = patient_id);

CREATE POLICY "Doctors have full admin control on appointments" 
ON public.appointments FOR ALL 
USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'doctor');


-- C. Doctor Availability Table Policies
CREATE POLICY "Anyone can view doctor availability" 
ON public.doctor_availability FOR SELECT 
USING (true);

CREATE POLICY "Doctors have full control on availability" 
ON public.doctor_availability FOR ALL 
USING (coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'doctor');


-- ==========================================
-- HELPER TRIGGERS FOR TIMESTAMPS
-- ==========================================

CREATE OR REPLACE FUNCTION update_modified_column()   
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;   
END;
$$ language 'plpgsql';

CREATE TRIGGER update_patients_modtime BEFORE UPDATE ON public.patients FOR EACH ROW EXECUTE PROCEDURE update_modified_column();
CREATE TRIGGER update_appointments_modtime BEFORE UPDATE ON public.appointments FOR EACH ROW EXECUTE PROCEDURE update_modified_column();


-- ==========================================
-- DOCTOR INITIAL SEED POINTERS
-- ==========================================
-- For manual creation of Doctor Roles if you do not use the automatic seed system,
-- you can run this query inside the Supabase SQL editor to upgrade an existing user's role:
--
-- UPDATE auth.users 
-- SET app_metadata = jsonb_build_object('role', 'doctor') 
-- WHERE email = 'YOUR_DOCTOR_EMAIL';

-- ==========================================
-- PERMISSIONS & ROLES GRANTS (FIX FOR FOREIGN KEY CONSTRAINTS)
-- ==========================================
-- Ensure that the anon and authenticated roles have permission to validate foreign keys referencing auth.users.
-- This prevents the "permission denied for table users" error during inserts.
GRANT SELECT ON auth.users TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.patients TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.appointments TO anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.doctor_availability TO anon, authenticated, service_role;


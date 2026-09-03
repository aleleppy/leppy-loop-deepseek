import koffi from 'koffi'

interface WindowsJobApi {
  createJob: (attributes: null, name: null) => unknown
  setInformation: (job: unknown, informationClass: number, information: Buffer, length: number) => number
  openProcess: (access: number, inherit: number, pid: number) => unknown
  assignProcess: (job: unknown, process: unknown) => number
  terminateJob: (job: unknown, exitCode: number) => number
  closeHandle: (handle: unknown) => number
  lastError: () => number
}

interface WindowsJobRecord {
  api: WindowsJobApi
  handle: unknown
}

const jobs = new Map<number, WindowsJobRecord>()
let api: WindowsJobApi | undefined

function windowsJobApi(): WindowsJobApi {
  if (api) return api
  const kernel = koffi.load('kernel32.dll')
  api = {
    createJob: kernel.func('__stdcall', 'CreateJobObjectW', 'void *', ['void *', 'str16']) as WindowsJobApi['createJob'],
    setInformation: kernel.func('__stdcall', 'SetInformationJobObject', 'int', ['void *', 'int', 'void *', 'uint32']) as WindowsJobApi['setInformation'],
    openProcess: kernel.func('__stdcall', 'OpenProcess', 'void *', ['uint32', 'int', 'uint32']) as WindowsJobApi['openProcess'],
    assignProcess: kernel.func('__stdcall', 'AssignProcessToJobObject', 'int', ['void *', 'void *']) as WindowsJobApi['assignProcess'],
    terminateJob: kernel.func('__stdcall', 'TerminateJobObject', 'int', ['void *', 'uint32']) as WindowsJobApi['terminateJob'],
    closeHandle: kernel.func('__stdcall', 'CloseHandle', 'int', ['void *']) as WindowsJobApi['closeHandle'],
    lastError: kernel.func('__stdcall', 'GetLastError', 'uint32', []) as WindowsJobApi['lastError'],
  }
  return api
}

function windowsFailure(label: string, value: WindowsJobApi): Error {
  return new Error(`${label} failed with Windows error ${value.lastError()}`)
}

/** Assign the permit-blocked bootstrap to a kill-on-close Windows Job before it can execute the gate. */
export function containWindowsGateProcess(pid: number): void {
  if (process.platform !== 'win32') return
  if (jobs.has(pid)) throw new Error('gate process already has Windows Job containment')
  const value = windowsJobApi()
  const job = value.createJob(null, null)
  if (!job) throw windowsFailure('CreateJobObjectW', value)
  let assigned = false
  let processHandle: unknown
  try {
    // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on 64-bit Windows; LimitFlags is offset 16.
    const limits = Buffer.alloc(process.arch === 'ia32' ? 112 : 144)
    limits.writeUInt32LE(0x00002000, 16) // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!value.setInformation(job, 9, limits, limits.length)) throw windowsFailure('SetInformationJobObject', value)
    processHandle = value.openProcess(0x0001 | 0x0100 | 0x1000, 0, pid)
    if (!processHandle) throw windowsFailure('OpenProcess', value)
    if (!value.assignProcess(job, processHandle)) throw windowsFailure('AssignProcessToJobObject', value)
    assigned = true
    jobs.set(pid, { api: value, handle: job })
  } finally {
    if (processHandle) value.closeHandle(processHandle)
    if (!assigned) value.closeHandle(job)
  }
}

/** Kill every process in the gate Job and close its controller-owned handle. */
export function settleWindowsGateJob(pid: number): boolean {
  const record = jobs.get(pid)
  if (!record) return false
  jobs.delete(pid)
  try {
    if (!record.api.terminateJob(record.handle, 1)) throw windowsFailure('TerminateJobObject', record.api)
  } finally {
    record.api.closeHandle(record.handle)
  }
  return true
}

module.exports = {
  github: {
    token: process.env.GITHUB_TOKEN,  // ← САМО това, без || 'ghp_...'
    owner: process.env.GITHUB_OWNER || 'NewTime-Creator',
    repo: process.env.GITHUB_REPO || '-radio-media-files',
    releaseTag: process.env.GITHUB_RELEASE_TAG || 'v1.0'
  },
  supabase: {
    url: process.env.SUPABASE_URL || 'https://bmxbwywhllumcbcuiejr.supabase.co',
    key: process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJteGJ3eXdobGx1bWNiY3VpZWpyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTgyODYzNTIsImV4cCI6MjA3Mzg2MjM1Mn0.irDCsnnYPYZf2zjleTiC0AQJn-uW8APYezeSq6RZr6A'
  }
};
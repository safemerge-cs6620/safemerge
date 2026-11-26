const API = "https://api.github.com";

export function makeGithub(getToken) {
  const headers = async (accept) => ({
    Authorization: `Bearer ${await getToken()}`, Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "safemerge-sast-worker",
  });
  return {
    async listChangedFiles(repo, pr) {
      const all = [];
      for (let page = 1; page <= 10; page++) {
        const r = await fetch(`${API}/repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`, { headers: await headers("application/vnd.github+json") });
        if (!r.ok) throw new Error(`GitHub files ${r.status}`);
        const batch = await r.json();
        all.push(...batch);
        if (batch.length < 100) break;
      }
      return all;
    },
    async getFile(repo, path, ref) {
      const enc = path.split("/").map(encodeURIComponent).join("/");
      const r = await fetch(`${API}/repos/${repo}/contents/${enc}?ref=${ref}`, { headers: await headers("application/vnd.github.raw+json") });
      if (!r.ok) throw new Error(`GitHub contents ${r.status}`);
      return r.text();
    },
  };
}

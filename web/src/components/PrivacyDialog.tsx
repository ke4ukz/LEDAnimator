/** Privacy modal: this is a client-only app — nothing is collected or uploaded. */
export function PrivacyDialog({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>Privacy</h2>
          <button className="x" onClick={onClose} title="Close">×</button>
        </div>

        <div className="dialog-prose">
          <p>Your work stays in your browser. LED Animator has no accounts and no backend to send data to.</p>
          <ul>
            <li>
              Projects autosave to your browser's local storage so they survive a reload — they never
              leave your device unless you export a file yourself.
            </li>
            <li>No cookies, no analytics, no tracking.</li>
            <li>
              Exports (<code>.uf2</code> / <code>.zip</code> / <code>.leda</code>) are generated locally in
              your browser.
            </li>
            <li>
              The app is served as static files by GitHub Pages. Like any web host, GitHub may record
              standard request logs (such as your IP address) — see{' '}
              <a
                href="https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement"
                target="_blank"
                rel="noopener noreferrer"
              >
                GitHub's Privacy Statement
              </a>
              .
            </li>
          </ul>
        </div>
      </div>
    </div>
  )
}

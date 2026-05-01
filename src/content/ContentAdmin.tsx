import styles from './ContentAdmin.module.css'

export function ContentAdmin() {
  return (
    <main className={styles.shell} aria-label="Content admin">
      <div className={styles.placeholder}>
        <h1>Content</h1>
        <p>Content documents are loading.</p>
      </div>
    </main>
  )
}

import { afterEach, describe, expect, it, mock } from 'bun:test'
import React, { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ContextMenu, ContextMenuItem } from '@ui/components/ContextMenu'

afterEach(cleanup)

function PointContextMenuHarness({
  onClose,
  onTargetClick,
  animateExit,
}: {
  onClose: () => void
  onTargetClick: () => void
  animateExit?: boolean
}) {
  const [open, setOpen] = useState(true)

  return (
    <>
      <button type="button" onClick={onTargetClick}>
        Different element
      </button>
      {open && (
        <ContextMenu
          x={24}
          y={32}
          ariaLabel="Node options"
          animateExit={animateExit}
          onClose={() => {
            onClose()
            setOpen(false)
          }}
        >
          <ContextMenuItem onClick={() => {}}>Rename</ContextMenuItem>
        </ContextMenu>
      )}
    </>
  )
}

describe('ContextMenu', () => {
  it('lets the first outside click close a point menu and activate the clicked target', () => {
    const onClose = mock(() => {})
    const onTargetClick = mock(() => {})

    render(
      <PointContextMenuHarness
        onClose={onClose}
        onTargetClick={onTargetClick}
      />,
    )

    expect(screen.getByRole('menu', { name: /node options/i })).toBeDefined()

    const target = screen.getByRole('button', { name: /different element/i })
    fireEvent.mouseDown(target)
    fireEvent.click(target)

    // Default (no animateExit): close is synchronous.
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onTargetClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('menu', { name: /node options/i })).toBeNull()
  })

  it('defers close behind an exit animation when animateExit is set', async () => {
    const onClose = mock(() => {})
    const onTargetClick = mock(() => {})

    render(
      <PointContextMenuHarness
        onClose={onClose}
        onTargetClick={onTargetClick}
        animateExit
      />,
    )

    const target = screen.getByRole('button', { name: /different element/i })
    fireEvent.mouseDown(target)
    fireEvent.click(target)

    // The underlying target still activates immediately — the dismiss
    // listener doesn't cancel the event.
    expect(onTargetClick).toHaveBeenCalledTimes(1)

    // The menu plays its exit animation first; the caller's `onClose`
    // (the real unmount) is deferred until the animation window elapses.
    const menu = screen.getByRole('menu', { name: /node options/i })
    expect(menu.getAttribute('data-closing')).toBe('')
    expect(onClose).toHaveBeenCalledTimes(0)

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByRole('menu', { name: /node options/i })).toBeNull()
  })

  it('dismisses on a click inside a same-origin iframe document', async () => {
    function IframeDismissHarness({ onClose }: { onClose: () => void }) {
      const [doc, setDoc] = useState<Document | null>(null)
      const [open, setOpen] = useState(true)
      return (
        <>
          <iframe
            title="canvas"
            ref={(el) => setDoc(el?.contentDocument ?? null)}
          />
          {open && (
            <ContextMenu
              x={24}
              y={32}
              ariaLabel="Node options"
              animateExit
              onClose={() => {
                onClose()
                setOpen(false)
              }}
            />
          )}
          {/* Render a click target into the iframe document so a mousedown
              fires on the iframe's document, not the parent's. */}
          {doc?.body &&
            (() => {
              if (!doc.getElementById('inside')) {
                const btn = doc.createElement('button')
                btn.id = 'inside'
                btn.textContent = 'inside'
                doc.body.appendChild(btn)
              }
              return null
            })()}
        </>
      )
    }

    const onClose = mock(() => {})
    const { container } = render(<IframeDismissHarness onClose={onClose} />)

    const iframe = container.querySelector('iframe') as HTMLIFrameElement
    await waitFor(() => {
      expect(iframe.contentDocument?.getElementById('inside')).not.toBeNull()
    })

    const insideButton = iframe.contentDocument!.getElementById('inside')!
    fireEvent.mouseDown(insideButton)

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1)
    })
  })
})

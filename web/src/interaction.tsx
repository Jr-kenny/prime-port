import { type ButtonHTMLAttributes, type MouseEvent, type MouseEventHandler, type ReactNode, useEffect, useRef, useState } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring } from "framer-motion";

type InteractiveTag = "div" | "section" | "article" | "aside" | "header" | "footer";

type RevealProps = {
  children: ReactNode;
  className?: string;
};

type MagneticButtonProps = {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>["onClick"];
  onMouseEnter?: ButtonHTMLAttributes<HTMLButtonElement>["onMouseEnter"];
  onMouseLeave?: ButtonHTMLAttributes<HTMLButtonElement>["onMouseLeave"];
  onMouseMove?: ButtonHTMLAttributes<HTMLButtonElement>["onMouseMove"];
  title?: string;
  type?: "button" | "submit" | "reset";
};

type InteractiveShellProps = {
  as?: InteractiveTag;
  children: ReactNode;
  className?: string;
  id?: string;
  role?: string;
  spotlight?: boolean;
  title?: string;
  onMouseEnter?: MouseEventHandler<HTMLElement>;
  onMouseLeave?: MouseEventHandler<HTMLElement>;
  onMouseMove?: MouseEventHandler<HTMLElement>;
};

type GlideItem = {
  key: string;
  label: ReactNode;
  active?: boolean;
  href?: string;
  onClick?: () => void;
  badge?: ReactNode;
};

type GlideGroupProps = {
  ariaLabel?: string;
  className?: string;
  items: GlideItem[];
  itemClassName?: string;
};

function useFinePointer() {
  const [hasFinePointer, setHasFinePointer] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(hover: hover) and (pointer: fine)");
    const update = () => setHasFinePointer(media.matches);
    update();

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", update);
      return () => media.removeEventListener("change", update);
    }

    media.addListener(update);
    return () => media.removeListener(update);
  }, []);

  return hasFinePointer;
}

function useInteractiveMode() {
  const prefersReducedMotion = useReducedMotion();
  const hasFinePointer = useFinePointer();

  return {
    allowMotion: !prefersReducedMotion,
    allowCursorEffects: !prefersReducedMotion && hasFinePointer,
  };
}

export function Reveal({ children, className }: RevealProps) {
  const { allowMotion } = useInteractiveMode();

  if (!allowMotion) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}

export function MagneticButton({ children, className, onMouseEnter, onMouseLeave, onMouseMove, ...props }: MagneticButtonProps) {
  const { allowMotion, allowCursorEffects } = useInteractiveMode();
  const [isHovering, setIsHovering] = useState(false);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const springX = useSpring(x, { stiffness: 280, damping: 22, mass: 0.25 });
  const springY = useSpring(y, { stiffness: 280, damping: 22, mass: 0.25 });

  if (!allowMotion) {
    return (
      <button className={className} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave} onMouseMove={onMouseMove} {...props}>
        {children}
      </button>
    );
  }

  return (
    <motion.button
      className={`${className ?? ""} motion-cta`}
      style={{ x: springX, y: springY, willChange: "transform" }}
      animate={{
        scale: isHovering ? 1.05 : 1,
        boxShadow: isHovering ? "0 18px 40px rgba(20, 146, 92, 0.22)" : "0 0 0 rgba(20, 146, 92, 0)",
      }}
      transition={{ type: "spring", stiffness: 320, damping: 24, mass: 0.25 }}
      onMouseEnter={(event) => {
        setIsHovering(true);
        y.set(-3);
        onMouseEnter?.(event);
      }}
      onMouseMove={(event) => {
        if (allowCursorEffects) {
          const rect = event.currentTarget.getBoundingClientRect();
          const offsetX = event.clientX - (rect.left + rect.width / 2);
          const offsetY = event.clientY - (rect.top + rect.height / 2);
          const distance = Math.hypot(offsetX, offsetY);
          const radius = 140;
          const strength = distance < radius ? 0.3 : 0;
          x.set(offsetX * strength);
          y.set(offsetY * strength - 3);
        }
        onMouseMove?.(event);
      }}
      onMouseLeave={(event) => {
        setIsHovering(false);
        x.set(0);
        y.set(0);
        onMouseLeave?.(event);
      }}
      {...props}
    >
      {children}
    </motion.button>
  );
}

export function InteractiveShell({
  as = "div",
  children,
  className,
  id,
  role,
  spotlight = false,
  title,
  onMouseEnter,
  onMouseLeave,
  onMouseMove,
}: InteractiveShellProps) {
  const { allowCursorEffects } = useInteractiveMode();
  const ref = useRef<HTMLElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const [isSpotlightActive, setIsSpotlightActive] = useState(false);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
      }
    };
  }, []);

  const sharedProps = {
    ref: (node: HTMLElement | null) => {
      ref.current = node;
    },
    id,
    role,
    title,
    className: `${className ?? ""} interactive-shell${spotlight ? " spotlight-surface" : ""}${isSpotlightActive ? " spotlight-active" : ""}`,
    onMouseEnter: (event: MouseEvent<HTMLElement>) => {
      if (spotlight && allowCursorEffects) {
        setIsSpotlightActive(true);
      }
      onMouseEnter?.(event);
    },
    onMouseMove: (event: MouseEvent<HTMLElement>) => {
      const node = ref.current;
      if (node && allowCursorEffects) {
        const rect = node.getBoundingClientRect();
        const offsetX = event.clientX - rect.left;
        const offsetY = event.clientY - rect.top;

        if (spotlight) {
          if (frameRef.current !== null) {
            cancelAnimationFrame(frameRef.current);
          }
          frameRef.current = requestAnimationFrame(() => {
            node.style.setProperty("--spotlight-x", `${offsetX}px`);
            node.style.setProperty("--spotlight-y", `${offsetY}px`);
          });
        }
      }
      onMouseMove?.(event);
    },
    onMouseLeave: (event: MouseEvent<HTMLElement>) => {
      setIsSpotlightActive(false);
      onMouseLeave?.(event);
    },
  };

  if (as === "section") {
    return (
      <motion.section {...sharedProps}>
        {children}
      </motion.section>
    );
  }

  if (as === "article") {
    return (
      <motion.article {...sharedProps}>
        {children}
      </motion.article>
    );
  }

  if (as === "aside") {
    return (
      <motion.aside {...sharedProps}>
        {children}
      </motion.aside>
    );
  }

  if (as === "header") {
    return (
      <motion.header {...sharedProps}>
        {children}
      </motion.header>
    );
  }

  if (as === "footer") {
    return (
      <motion.footer {...sharedProps}>
        {children}
      </motion.footer>
    );
  }

  return (
    <motion.div {...sharedProps}>
      {children}
    </motion.div>
  );
}

export function GlideGroup({ ariaLabel, className, items, itemClassName }: GlideGroupProps) {
  const { allowCursorEffects } = useInteractiveMode();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Record<string, HTMLElement | null>>({});
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const width = useMotionValue(0);
  const height = useMotionValue(0);
  const opacity = useMotionValue(0);
  const springX = useSpring(x, { stiffness: 260, damping: 24, mass: 0.3 });
  const springY = useSpring(y, { stiffness: 260, damping: 24, mass: 0.3 });
  const springWidth = useSpring(width, { stiffness: 260, damping: 24, mass: 0.3 });
  const springHeight = useSpring(height, { stiffness: 260, damping: 24, mass: 0.3 });
  const springOpacity = useSpring(opacity, { stiffness: 240, damping: 26, mass: 0.3 });
  const activeKey = items.find((item) => item.active)?.key;

  function moveToItem(key?: string, visible = true) {
    const container = containerRef.current;
    const item = key ? itemRefs.current[key] : null;
    if (!container || !item) {
      opacity.set(0);
      return;
    }

    const itemRect = item.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    x.set(itemRect.left - containerRect.left);
    y.set(itemRect.top - containerRect.top);
    width.set(itemRect.width);
    height.set(itemRect.height);
    opacity.set(visible ? 1 : 0);
  }

  useEffect(() => {
    if (!allowCursorEffects) return;
    moveToItem(activeKey, Boolean(activeKey));
  }, [activeKey, allowCursorEffects]);

  return (
    <div
      ref={containerRef}
      className={`${className ?? ""} glide-group`}
      aria-label={ariaLabel}
      onMouseLeave={() => moveToItem(activeKey, Boolean(activeKey))}
    >
      {allowCursorEffects && (
        <motion.span
          aria-hidden="true"
          className="glide-highlight"
          style={{
            x: springX,
            y: springY,
            width: springWidth,
            height: springHeight,
            opacity: springOpacity,
          }}
        />
      )}

      {items.map((item) => {
        const shared = {
          ref: (node: HTMLElement | null) => {
            itemRefs.current[item.key] = node;
          },
          className: `${itemClassName ?? ""}${item.active ? " active" : ""}`,
          onMouseEnter: () => moveToItem(item.key),
          onFocus: () => moveToItem(item.key),
        };

        if (item.href) {
          return (
            <a key={item.key} href={item.href} {...shared}>
              <span>{item.label}</span>
              {item.badge}
            </a>
          );
        }

        return (
          <button key={item.key} type="button" onClick={item.onClick} {...shared}>
            <span>{item.label}</span>
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}

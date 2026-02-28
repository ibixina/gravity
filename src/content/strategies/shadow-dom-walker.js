// Shadow DOM Walker
// on deeply nested modern web apps.

class ShadowDomWalker {
    /**
     * Iteratively walks the DOM using an explicit stack, piercing through
     * open shadow roots and closed shadow roots exposed by gravity-early.js.
     *
     * Iterative > recursive here because:
     *  - Avoids call-stack overflow on deeply nested SPAs (React, Angular)
     *  - Modern JS engines optimise loops better than deep recursion
     *  - Easier to apply a node-count budget without complex flow control
     *
     * @param {Node}     root     The root node to start walking from
     * @param {Function} callback Called for every ELEMENT_NODE found
     * @param {number}   [limit]  Max nodes to visit (default: 20,000)
     */
    static walk(root, callback, limit = 20000) {
        if (!root) return;

        const stack = [root];
        let visited = 0;

        while (stack.length > 0 && visited < limit) {
            const node = stack.pop();
            visited++;

            if (node.nodeType === Node.ELEMENT_NODE) {
                callback(node);

                // Descend into shadow root (open or hooked-closed)
                const shadowRoot = node.shadowRoot || node.__gravityShadowRoot;
                if (shadowRoot) {
                    stack.push(shadowRoot);
                }
            }

            // Push children in reverse order so left-to-right DOM order is preserved
            let child = node.lastChild;
            while (child) {
                stack.push(child);
                child = child.previousSibling;
            }
        }

        if (visited >= limit) {
            console.debug('[Gravity] Shadow walker hit node limit (' + limit + ') — large page');
        }
    }

    static querySelectorAllDeep(root, selector) {
        const results = [];
        this.walk(root, (node) => {
            if (node.matches && node.matches(selector)) {
                results.push(node);
            }
        });
        return results;
    }
}

window.GravityShadowDomWalker = ShadowDomWalker;

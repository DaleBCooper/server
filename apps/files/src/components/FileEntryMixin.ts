/**
 * SPDX-FileCopyrightText: 2024 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

import type { PropType } from 'vue'
import type { FileSource } from '../types.ts'

import { FileType, Permission, Folder, File as NcFile, NodeStatus, Node, getFileActions } from '@nextcloud/files'
import { generateUrl } from '@nextcloud/router'
import { isPublicShare } from '@nextcloud/sharing/public'
import { t } from '@nextcloud/l10n'
import { vOnClickOutside } from '@vueuse/components'
import { extname } from 'path'
import Vue, { computed, defineComponent } from 'vue'

import { action as sidebarAction } from '../actions/sidebarAction.ts'
import { getDragAndDropPreview } from '../utils/dragUtils.ts'
import { hashCode } from '../utils/hashUtils.ts'
import { isDownloadable } from '../utils/permissions.ts'
import logger from '../logger.ts'
import vFilesDrop from '../directives/vFilesDrop.ts'

const actions = getFileActions()

Vue.directive('onClickOutside', vOnClickOutside)
Vue.directive('filesDrop', vFilesDrop)

export default defineComponent({

	props: {
		source: {
			type: [Folder, NcFile, Node] as PropType<Node>,
			required: true,
		},
		nodes: {
			type: Array as PropType<Node[]>,
			required: true,
		},
		filesListWidth: {
			type: Number,
			default: 0,
		},
		isMtimeAvailable: {
			type: Boolean,
			default: false,
		},
		compact: {
			type: Boolean,
			default: false,
		},
	},

	provide() {
		return {
			defaultFileAction: computed(() => this.defaultFileAction),
			enabledFileActions: computed(() => this.enabledFileActions),
		}
	},

	data() {
		return {
			dragover: false,
			gridMode: false,
		}
	},

	computed: {
		fileid() {
			return this.source.fileid ?? 0
		},

		uniqueId() {
			return hashCode(this.source.source)
		},

		isLoading() {
			return this.source.status === NodeStatus.LOADING
		},

		isFolder() {
			return this.source.type === FileType.Folder
		},

		/**
		 * The display name of the current node
		 * Either the nodes filename or a custom display name (e.g. for shares)
		 */
		displayName() {
			// basename fallback needed for apps using old `@nextcloud/files` prior 3.6.0
			return this.source.displayname || this.source.basename
		},
		/**
		 * The display name without extension
		 */
		basename() {
			if (this.extension === '') {
				return this.displayName
			}
			return this.displayName.slice(0, 0 - this.extension.length)
		},
		/**
		 * The extension of the file
		 */
		extension() {
			if (this.isFolder) {
				return ''
			}

			return extname(this.displayName)
		},

		draggingFiles() {
			return this.draggingStore.dragging as FileSource[]
		},
		selectedFiles() {
			return this.selectionStore.selected as FileSource[]
		},
		isSelected() {
			return this.selectedFiles.includes(this.source.source)
		},

		isRenaming() {
			return this.renamingStore.renamingNode === this.source
		},
		isRenamingSmallScreen() {
			return this.isRenaming && this.filesListWidth < 512
		},

		isActive() {
			return String(this.fileid) === String(this.currentFileId)
		},

		/**
		 * Check if the source is in a failed state after an API request
		 */
		isFailedSource() {
			return this.source.status === NodeStatus.FAILED
		},

		canDrag() {
			if (this.isRenaming) {
				return false
			}

			const canDrag = (node: Node): boolean => {
				return (node?.permissions & Permission.UPDATE) !== 0
			}

			// If we're dragging a selection, we need to check all files
			if (this.selectedFiles.length > 0) {
				const nodes = this.selectedFiles.map(source => this.filesStore.getNode(source)) as Node[]
				return nodes.every(canDrag)
			}
			return canDrag(this.source)
		},

		canDrop() {
			if (this.source.type !== FileType.Folder) {
				return false
			}

			// If the current folder is also being dragged, we can't drop it on itself
			if (this.draggingFiles.includes(this.source.source)) {
				return false
			}

			return (this.source.permissions & Permission.CREATE) !== 0
		},

		openedMenu: {
			get() {
				return this.actionsMenuStore.opened === this.uniqueId.toString()
			},
			set(opened) {
				this.actionsMenuStore.opened = opened ? this.uniqueId.toString() : null
			},
		},

		mtimeOpacity() {
			const maxOpacityTime = 31 * 24 * 60 * 60 * 1000 // 31 days

			const mtime = this.source.mtime?.getTime?.()
			if (!mtime) {
				return {}
			}

			// 1 = today, 0 = 31 days ago
			const ratio = Math.round(Math.min(100, 100 * (maxOpacityTime - (Date.now() - mtime)) / maxOpacityTime))
			if (ratio < 0) {
				return {}
			}
			return {
				color: `color-mix(in srgb, var(--color-main-text) ${ratio}%, var(--color-text-maxcontrast))`,
			}
		},

		/**
		 * Sorted actions that are enabled for this node
		 */
		enabledFileActions() {
			if (this.source.status === NodeStatus.FAILED) {
				return []
			}

			return actions
				.filter(action => {
					if (!action.enabled) {
						return true
					}

					// In case something goes wrong, since we don't want to break
					// the entire list, we filter out actions that throw an error.
					try {
						return action.enabled([this.source], this.currentView)
					} catch (error) {
						logger.error('Error while checking action', { action, error })
						return false
					}
				})
				.sort((a, b) => (a.order || 0) - (b.order || 0))
		},

		defaultFileAction() {
			return this.enabledFileActions.find((action) => action.default !== undefined)
		},
	},

	watch: {
		/**
		 * When the source changes, reset the preview
		 * and fetch the new one.
		 * @param a
		 * @param b
		 */
		source(a: Node, b: Node) {
			if (a.source !== b.source) {
				this.resetState()
			}
		},

		openedMenu() {
			if (this.openedMenu === false) {
				// TODO: This timeout can be removed once `close` event only triggers after the transition
				// ref: https://github.com/nextcloud-libraries/nextcloud-vue/pull/6065
				window.setTimeout(() => {
					if (this.openedMenu) {
						// was reopened while the animation run
						return
					}
					// Reset any right menu position potentially set
					const root = document.getElementById('app-content-vue')
					if (root !== null) {
						root.style.removeProperty('--mouse-pos-x')
						root.style.removeProperty('--mouse-pos-y')
					}
				}, 300)
			}
		},
	},

	beforeDestroy() {
		this.resetState()
	},

	methods: {
		resetState() {
			// Reset the preview state
			this.$refs?.preview?.reset?.()

			// Close menu
			this.openedMenu = false
		},

		// Open the actions menu on right click
		onRightClick(event) {
			// If already opened, fallback to default browser
			if (this.openedMenu) {
				return
			}

			// The grid mode is compact enough to not care about
			// the actions menu mouse position
			if (!this.gridMode) {
				// Actions menu is contained within the app content
				const root = this.$el?.closest('main.app-content') as HTMLElement
				const contentRect = root.getBoundingClientRect()
				// Using Math.min/max to prevent the menu from going out of the AppContent
				// 200 = max width of the menu
				root.style.setProperty('--mouse-pos-x', Math.max(0, event.clientX - contentRect.left - 200) + 'px')
				root.style.setProperty('--mouse-pos-y', Math.max(0, event.clientY - contentRect.top) + 'px')
			} else {
				// Reset any right menu position potentially set
				const root = this.$el?.closest('main.app-content') as HTMLElement
				root.style.removeProperty('--mouse-pos-x')
				root.style.removeProperty('--mouse-pos-y')
			}

			// If the clicked row is in the selection, open global menu
			const isMoreThanOneSelected = this.selectedFiles.length > 1
			this.actionsMenuStore.opened = this.isSelected && isMoreThanOneSelected ? 'global' : this.uniqueId.toString()

			// Prevent any browser defaults
			event.preventDefault()
			event.stopPropagation()
		},

		execDefaultAction(event: MouseEvent) {
			// Ignore click if we are renaming
			if (this.isRenaming) {
				return
			}

			// Ignore right click (button & 2) and any auxiliary button expect mouse-wheel (button & 4)
			if (Boolean(event.button & 2) || event.button > 4) {
				return
			}

			// if ctrl+click / cmd+click (MacOS uses the meta key) or middle mouse button (button & 4), open in new tab
			// also if there is no default action use this as a fallback
			const metaKeyPressed = event.ctrlKey || event.metaKey || Boolean(event.button & 4)
			if (metaKeyPressed || !this.defaultFileAction) {
				// If no download permission, then we can not allow to download (direct link) the files
				if (isPublicShare() && !isDownloadable(this.source)) {
					return
				}

				const url = isPublicShare()
					? this.source.encodedSource
					: generateUrl('/f/{fileId}', { fileId: this.fileid })
				event.preventDefault()
				event.stopPropagation()
				window.open(url, metaKeyPressed ? '_self' : undefined)
				return
			}

			// every special case handled so just execute the default action
			event.preventDefault()
			event.stopPropagation()
			// Execute the first default action if any
			this.defaultFileAction.exec(this.source, this.currentView, this.currentDir)
		},

		openDetailsIfAvailable(event) {
			event.preventDefault()
			event.stopPropagation()
			if (sidebarAction?.enabled?.([this.source], this.currentView)) {
				sidebarAction.exec(this.source, this.currentView, this.currentDir)
			}
		},

		onDragOver(event: DragEvent) {
			this.dragover = this.canDrop
			if (!this.canDrop) {
				event.dataTransfer.dropEffect = 'none'
				return
			}

			// Handle copy/move drag and drop
			if (event.ctrlKey) {
				event.dataTransfer.dropEffect = 'copy'
			} else {
				event.dataTransfer.dropEffect = 'move'
			}
		},

		onDragLeave(event: DragEvent) {
			// Counter bubbling, make sure we're ending the drag
			// only when we're leaving the current element
			const currentTarget = event.currentTarget as HTMLElement
			if (currentTarget?.contains(event.relatedTarget as HTMLElement)) {
				return
			}

			this.dragover = false
		},

		/**
		 * Callback when the drop listener is done.
		 * We reset the dragover state.
		 */
		onDrop() {
			this.dragover = false
		},

		async onDragStart(event: DragEvent) {
			event.stopPropagation()
			if (!this.canDrag || !this.fileid) {
				event.preventDefault()
				event.stopPropagation()
				return
			}

			logger.debug('Drag started', { event })

			// Make sure that we're not dragging a file like the preview
			event.dataTransfer?.clearData?.()

			// Reset any renaming
			this.renamingStore.$reset()

			// Dragging set of files, if we're dragging a file
			// that is already selected, we use the entire selection
			if (this.selectedFiles.includes(this.source.source)) {
				this.draggingStore.set(this.selectedFiles)
			} else {
				this.draggingStore.set([this.source.source])
			}

			const nodes = this.draggingStore.dragging
				.map(source => this.filesStore.getNode(source)) as Node[]

			const image = await getDragAndDropPreview(nodes)
			event.dataTransfer?.setDragImage(image, -10, -10)
		},

		onDragEnd() {
			this.draggingStore.reset()
			this.dragover = false
			logger.debug('Drag ended')
		},

		t,
	},
})

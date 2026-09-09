using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.UI;
using SkillApp.PopShot;
using SkillApp.PopShot.Simulation;
using SkillApp.PopShot.View;

namespace SkillApp.EditorTools
{
    /// <summary>
    /// Builds the Pop Shot half of the scene.
    ///
    /// Scripted, like everything else in this project, for the reason stated in
    /// ChickenRunScene: a scene built by hand is a binary blob whose diff nobody
    /// can read, and every layout decision in it is undocumented. Built by code,
    /// the scene has a changelog and every magic number has a comment next to it.
    ///
    /// The cost is real and worth restating: the editor is read-only. Dragging
    /// something in the inspector and pressing play works, and is then destroyed
    /// the next time this runs.
    /// </summary>
    public static class PopShotScene
    {
        /// <summary>
        /// Build the whole Pop Shot hierarchy and return its root.
        ///
        /// The root exists so GameHost can switch the game off with one SetActive
        /// rather than loading a scene — see GameHost for why scene loading is
        /// avoided inside an embedded player.
        /// </summary>
        public static GameObject Build(Material boardMaterial, out MonoBehaviour session)
        {
            var root = new GameObject("Game_PopShot");

            // ── Camera ───────────────────────────────────────────────────────
            // Orthographic and dead-on. Pop Shot is a 2D game and the brief asks
            // for one; any yaw or pitch would make judging the ball's height
            // against the rim harder, and height is the entire skill.
            var camGo = new GameObject("PopShot Camera");
            camGo.transform.SetParent(root.transform, false);
            var cam = camGo.AddComponent<Camera>();
            cam.orthographic = true;
            cam.clearFlags = CameraClearFlags.SolidColor;
            // A darker ground than Chicken Run's sky, so the two games are
            // instantly distinguishable even in a thumbnail.
            cam.backgroundColor = new Color(0.10f, 0.12f, 0.18f);
            cam.nearClipPlane = 0.1f;
            cam.farClipPlane = 100f;
            cam.depth = 0;

            const float courtW = (float)Sim.CourtW / Sim.Sub;
            const float courtH = (float)Sim.CourtH / Sim.Sub;

            // A starting value only. PopShotView re-derives this every frame from
            // the real aspect ratio, because WIDTH is the binding dimension in
            // portrait and the editor's Game view is not the phone's shape.
            cam.orthographicSize = courtH * 0.5f;
            camGo.transform.position = new Vector3(courtW * 0.5f, courtH * 0.5f, -20f);
            camGo.transform.rotation = Quaternion.identity;

            // ── Light ────────────────────────────────────────────────────────
            var lightGo = new GameObject("PopShot Light");
            lightGo.transform.SetParent(root.transform, false);
            var light = lightGo.AddComponent<Light>();
            light.type = LightType.Directional;
            light.intensity = 1.0f;
            lightGo.transform.rotation = Quaternion.Euler(35f, -20f, 0f);

            // ── Game ─────────────────────────────────────────────────────────
            var gameGo = new GameObject("PopShot");
            gameGo.transform.SetParent(root.transform, false);
            var game = gameGo.AddComponent<PopShotGame>();
            var input = gameGo.AddComponent<PopShotInput>();
            var view = gameGo.AddComponent<PopShotView>();

            var feedbackGo = new GameObject("PopShot Feedback");
            feedbackGo.transform.SetParent(root.transform, false);
            var feedback = feedbackGo.AddComponent<PopShotFeedback>();

            var sessionGo = new GameObject("PopShot Session");
            sessionGo.transform.SetParent(root.transform, false);
            var sess = sessionGo.AddComponent<PopShotSession>();

            // ── HUD ──────────────────────────────────────────────────────────
            var hud = BuildHud(root.transform, game, out var scoreLabel,
                out var clockLabel, out var hintLabel);

            // ── Wiring ───────────────────────────────────────────────────────
            Wire(input, ("game", game));
            Wire(view, ("game", game), ("camera", cam), ("boardMaterial", boardMaterial));
            Wire(feedback, ("game", game));
            Wire(hud, ("game", game), ("scoreLabel", scoreLabel),
                ("clockLabel", clockLabel), ("hintLabel", hintLabel));
            Wire(sess, ("game", game), ("hud", hud), ("feedback", feedback));

            session = sess;
            return root;
        }

        private static PopShotHud BuildHud(
            Transform parent, PopShotGame game,
            out TextMeshProUGUI score, out TextMeshProUGUI clock, out TextMeshProUGUI hint)
        {
            var canvasGo = new GameObject("PopShot HUD",
                typeof(RectTransform), typeof(Canvas), typeof(CanvasScaler), typeof(GraphicRaycaster));
            canvasGo.transform.SetParent(parent, false);

            var canvas = canvasGo.GetComponent<Canvas>();
            canvas.renderMode = RenderMode.ScreenSpaceOverlay;
            // Above Chicken Run's HUD is irrelevant (only one is ever active), but
            // a fixed order stops the two fighting if both are briefly on.
            canvas.sortingOrder = 10;

            var scaler = canvasGo.GetComponent<CanvasScaler>();
            scaler.uiScaleMode = CanvasScaler.ScaleMode.ScaleWithScreenSize;
            scaler.referenceResolution = new Vector2(1080f, 1920f);
            // Match height: portrait, so vertical space is what the layout is
            // built against.
            scaler.matchWidthOrHeight = 1f;

            var safeGo = new GameObject("SafeArea", typeof(RectTransform),
                typeof(SkillApp.ChickenRun.View.SafeAreaFrame));
            safeGo.transform.SetParent(canvasGo.transform, false);
            var safe = (RectTransform)safeGo.transform;
            safe.anchorMin = Vector2.zero;
            safe.anchorMax = Vector2.one;
            safe.offsetMin = Vector2.zero;
            safe.offsetMax = Vector2.zero;

            score = Label(safe, "Score", 96f, new Vector2(0.5f, 1f), new Vector2(0f, -110f));
            score.alignment = TextAlignmentOptions.Center;

            clock = Label(safe, "Clock", 52f, new Vector2(0.5f, 1f), new Vector2(0f, -215f));
            clock.alignment = TextAlignmentOptions.Center;

            hint = Label(safe, "Hint", 34f, new Vector2(0.5f, 0f), new Vector2(0f, 150f));
            hint.alignment = TextAlignmentOptions.Center;
            hint.color = new Color(1f, 1f, 1f, 0.65f);

            return canvasGo.AddComponent<PopShotHud>();
        }

        private static TextMeshProUGUI Label(
            Transform parent, string name, float size, Vector2 anchor, Vector2 offset)
        {
            var go = new GameObject(name, typeof(RectTransform));
            go.transform.SetParent(parent, false);

            var label = go.AddComponent<TextMeshProUGUI>();
            label.fontSize = size;
            label.color = Color.white;
            label.text = "";

            var rt = (RectTransform)go.transform;
            rt.anchorMin = anchor;
            rt.anchorMax = anchor;
            rt.pivot = new Vector2(0.5f, anchor.y);
            rt.sizeDelta = new Vector2(900f, size * 1.4f);
            rt.anchoredPosition = offset;

            return label;
        }

        /// <summary>
        /// Wire serialized references through SerializedObject rather than public
        /// fields, so the inspector-facing API stays [SerializeField] private —
        /// which is what stops other code reaching in at runtime.
        /// </summary>
        private static void Wire(Object target, params (string field, Object value)[] pairs)
        {
            var so = new SerializedObject(target);
            foreach (var (field, value) in pairs)
            {
                var prop = so.FindProperty(field);
                if (prop == null)
                {
                    Debug.LogWarning($"[scene] {target.GetType().Name} has no field '{field}'");
                    continue;
                }
                prop.objectReferenceValue = value;
            }
            so.ApplyModifiedPropertiesWithoutUndo();
        }
    }
}

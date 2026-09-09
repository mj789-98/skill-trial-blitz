using System.Collections.Generic;
using UnityEngine;
using SkillApp.ChickenRun.Simulation;

namespace SkillApp.ChickenRun.View
{
    /// <summary>
    /// Renders the world the simulation describes.
    ///
    /// ── The one rule ─────────────────────────────────────────────────────────
    ///
    /// This class READS the simulation and never writes to it. It uses floats
    /// freely — positions, easing, colour — because none of it feeds back. If you
    /// ever find yourself wanting to push a value from here into Sim, that is the
    /// bug: the server does not run this code, so anything decided here does not
    /// exist as far as scoring is concerned.
    ///
    /// ── Why it draws from closed-form queries ────────────────────────────────
    ///
    /// Traffic, logs and trains are pure functions of (seed, row, tick), so the
    /// view asks the simulation where a car is at the current tick rather than
    /// keeping its own moving objects. That means the cars you see are provably
    /// the cars you can be hit by — a renderer with its own physics would drift
    /// from the thing that kills you, and the player would be hit by a gap.
    ///
    /// ── Pooling ──────────────────────────────────────────────────────────────
    ///
    /// Rows are recycled as the camera advances. A run can reach hundreds of rows
    /// and instantiating per row would stutter, which is a frame-pacing problem in
    /// a game whose whole feel is rhythm.
    /// </summary>
    public class WorldView : MonoBehaviour
    {
        [SerializeField] private ChickenRunGame game;

        /// <summary>
        /// Assigned by the scene builder to a real material asset.
        ///
        /// This MUST be a serialized reference rather than Shader.Find at
        /// runtime. A shader that no material in the scene references is stripped
        /// from a player build, so Shader.Find returns null there and every
        /// renderer draws magenta — while working perfectly in the editor, which
        /// has everything loaded. Referencing the asset is what makes the shader
        /// ship.
        /// </summary>
        [SerializeField] private Material boardMaterial;

        [Header("Visible window")]
        /// Rows drawn ahead of the chicken. Enough that the player can read and
        /// plan the next few hops, which is what makes a death feel fair.
        ///
        /// Sized from the CAMERA, not from taste: the rig is orthographic and
        /// yawed 35 degrees, so a portrait screen covers a long diagonal band of
        /// rows. 14 was enough in the editor's wide Game view and left a wedge of
        /// bare sky on a 20:9 phone.
        [SerializeField] private int rowsAhead = 24;

        /// Rows kept behind, so the ground does not visibly vanish underfoot.
        /// Generous for the same reason, and because "behind" is a large part of
        /// a yawed frame.
        [SerializeField] private int rowsBehind = 16;

        [Header("Palette")]
        [SerializeField] private Color grassA = new Color(0.42f, 0.78f, 0.35f);
        [SerializeField] private Color grassB = new Color(0.38f, 0.73f, 0.32f);
        [SerializeField] private Color road = new Color(0.34f, 0.35f, 0.38f);
        [SerializeField] private Color rail = new Color(0.55f, 0.47f, 0.38f);
        [SerializeField] private Color water = new Color(0.30f, 0.62f, 0.88f);
        [SerializeField] private Color obstacle = new Color(0.20f, 0.45f, 0.22f);
        [SerializeField] private Color vehicle = new Color(0.90f, 0.35f, 0.30f);
        [SerializeField] private Color log = new Color(0.55f, 0.38f, 0.22f);
        [SerializeField] private Color train = new Color(0.85f, 0.80f, 0.25f);
        [SerializeField] private Color signalOn = new Color(1f, 0.25f, 0.20f);

        /// <summary>
        /// The advancing kill line. Deliberately readable, not subtle.
        ///
        /// Opaque, not alpha-blended: the board shares one unlit OPAQUE material,
        /// so alpha is ignored. Rather than introduce a second transparent
        /// material and a sorting problem for one band, it darkens by lerping the
        /// colour itself, which reads the same at a fraction of the complexity.
        /// </summary>
        [SerializeField] private Color idleShadowNear = new Color(0.16f, 0.18f, 0.30f);
        [SerializeField] private Color idleShadowClose = new Color(0.04f, 0.04f, 0.10f);

        private readonly Dictionary<int, GameObject> _rows = new Dictionary<int, GameObject>();
        private readonly Stack<GameObject> _rowPool = new Stack<GameObject>();
        private readonly List<GameObject> _movers = new List<GameObject>();
        private readonly Stack<GameObject> _moverPool = new Stack<GameObject>();

        private Transform _root;
        private Material _sharedMaterial;
        private GameObject _shadowQuad;

        private void Awake()
        {
            _root = new GameObject("WorldRoot").transform;
            _root.SetParent(transform, false);

            // One unlit material, instanced per renderer via a property block.
            // A stylised low-poly board needs no lighting model, and unlit is
            // dramatically cheaper on the mid-range Android this targets.
            if (boardMaterial != null)
            {
                _sharedMaterial = boardMaterial;
            }
            else
            {
                // Editor-only convenience so the scene still renders if it was
                // opened before the builder assigned the asset. Never relied on
                // in a build — see the field comment.
                var shader = Shader.Find("Universal Render Pipeline/Unlit")
                             ?? Shader.Find("Unlit/Color");
                if (shader == null)
                {
                    Debug.LogError(
                        "[world] no board material assigned and the unlit shader was " +
                        "stripped from this build; everything will draw magenta.");
                    return;
                }
                _sharedMaterial = new Material(shader);
            }

            _shadowQuad = BuildQuad("IdleShadow", idleShadowNear);
            _shadowQuad.transform.SetParent(_root, false);
            _shadowQuad.SetActive(false);
        }

        private void LateUpdate()
        {
            if (game == null || game.State == null) return;
            Redraw(game.State);
        }

        private void Redraw(Sim.State state)
        {
            int centre = state.Row;
            // NOT clamped at row 0. The board starts at row 0 but the camera can
            // see well behind it, and clamping left the bottom-right of the frame
            // as raw background — the world looked like it was floating on a blue
            // void for the first several hops of every run, which is exactly the
            // moment a player is deciding whether this is a real game.
            //
            // Negative rows are free: Sim.RowTypeAt returns grass for any row <= 2,
            // so the run-up renders as plain field and carries no hazards, no
            // lanes and no meaning to the simulation.
            int from = centre - rowsBehind;
            int to = centre + rowsAhead;

            // Recycle rows that have left the window.
            var stale = new List<int>();
            foreach (var kv in _rows)
            {
                if (kv.Key < from || kv.Key > to) stale.Add(kv.Key);
            }
            foreach (var row in stale)
            {
                var go = _rows[row];
                go.SetActive(false);
                _rowPool.Push(go);
                _rows.Remove(row);
            }

            for (int row = from; row <= to; row++)
            {
                if (!_rows.ContainsKey(row)) _rows[row] = BuildRow(state.Seed, row);
            }

            RedrawMovers(state, from, to);
            RedrawIdleShadow(state);
        }

        private GameObject BuildRow(uint seed, int row)
        {
            var go = _rowPool.Count > 0 ? _rowPool.Pop() : BuildQuad("Row", Color.white);
            go.SetActive(true);
            go.transform.SetParent(_root, false);
            go.transform.localScale = new Vector3(Sim.Cols, 1f, 1f);
            go.transform.localPosition = new Vector3((Sim.Cols - 1) * 0.5f, 0f, row);

            int kind = Sim.RowTypeAt(seed, row);
            Color c;
            switch (kind)
            {
                case Sim.RowRoad: c = road; break;
                case Sim.RowRail: c = rail; break;
                case Sim.RowRiver: c = water; break;
                // Alternating grass bands give the eye a sense of forward motion
                // that a single flat colour does not.
                default: c = (row % 2 == 0) ? grassA : grassB; break;
            }
            Tint(go, c);

            // Static obstacles sit on the row itself; they never move, so they are
            // built once with the row rather than every frame.
            var existing = go.GetComponent<RowObstacles>() ?? go.AddComponent<RowObstacles>();
            existing.Rebuild(this, seed, row, kind);

            return go;
        }

        /// <summary>Draw everything that moves, straight from the closed-form queries.</summary>
        private void RedrawMovers(Sim.State state, int from, int to)
        {
            foreach (var m in _movers)
            {
                m.SetActive(false);
                _moverPool.Push(m);
            }
            _movers.Clear();

            // The renderer interpolates between ticks so 50Hz logic reads as
            // continuous motion. This is float maths on top of an integer
            // simulation, which is exactly where floats belong.
            float tick = state.Tick + game.TickAlpha;

            for (int row = from; row <= to; row++)
            {
                int kind = Sim.RowTypeAt(state.Seed, row);

                if (kind == Sim.RowRoad || kind == Sim.RowRiver)
                {
                    var lane = Sim.LaneTraffic(state.Seed, row, kind);
                    bool isRoad = kind == Sim.RowRoad;
                    for (int i = 0; i < lane.Count; i++)
                    {
                        float posSub = InterpolatedBodyPos(lane, i, tick);
                        float cells = lane.LengthSub / (float)Sim.Sub;
                        float x = posSub / Sim.Sub + cells * 0.5f - 0.5f;

                        var go = TakeMover();
                        go.transform.localScale = new Vector3(cells, 1f, isRoad ? 0.62f : 0.78f);
                        go.transform.localPosition = new Vector3(x, isRoad ? 0.02f : 0.01f, row);
                        Tint(go, isRoad ? vehicle : log);

                        // A body straddling the wrap point must be drawn twice or
                        // it visibly pops out of existence at the board edge.
                        if (posSub + lane.LengthSub > Sim.TrackSub)
                        {
                            var wrap = TakeMover();
                            wrap.transform.localScale = go.transform.localScale;
                            wrap.transform.localPosition =
                                go.transform.localPosition - new Vector3(Sim.Cols, 0f, 0f);
                            Tint(wrap, isRoad ? vehicle : log);
                        }
                    }
                }
                else if (kind == Sim.RowRail)
                {
                    var sched = Sim.RailSchedule(state.Seed, row);
                    if (Sim.TrainPresent(sched, state.Tick))
                    {
                        var go = TakeMover();
                        go.transform.localScale = new Vector3(Sim.Cols, 1f, 0.7f);
                        go.transform.localPosition =
                            new Vector3((Sim.Cols - 1) * 0.5f, 0.03f, row);
                        Tint(go, train);
                    }
                    else if (Sim.TrainWarning(sched, state.Tick))
                    {
                        // The signal is driven by the SAME schedule the simulation
                        // kills from, so a flashing light always means a train is
                        // genuinely coming. A cosmetic signal would teach the
                        // player a timing that is not real.
                        var go = TakeMover();
                        float blink = Mathf.PingPong(Time.unscaledTime * 6f, 1f);
                        go.transform.localScale = new Vector3(0.34f, 1f, 0.34f);
                        go.transform.localPosition = new Vector3(-0.35f, 0.2f, row);
                        Tint(go, Color.Lerp(Color.black, signalOn, blink));
                    }
                }
            }
        }

        /// <summary>
        /// Where a body sits between ticks.
        ///
        /// Deliberately recomputed from the lane parameters rather than lerping
        /// between two BodyPos calls: near the wrap point those two values are a
        /// whole board apart, and lerping them sends the car sprinting backwards
        /// across the screen for one frame.
        /// </summary>
        private static float InterpolatedBodyPos(Sim.Lane lane, int i, float tick)
        {
            float raw = lane.Offset + i * lane.Gap + lane.Dir * lane.Speed * tick;
            float wrapped = raw % Sim.TrackSub;
            if (wrapped < 0) wrapped += Sim.TrackSub;
            return wrapped;
        }

        private void RedrawIdleShadow(Sim.State state)
        {
            // Show it only once the line is actually MOVING — i.e. the grace
            // period has expired and the player is being pushed.
            //
            // The first version tested `line >= row - IdleLeadRows`, which is true
            // on the very first tick of every run (the line rests exactly
            // IdleLeadRows behind), so the warning was permanently on screen and
            // stopped being a warning at all.
            int idleTicks = state.Tick - state.LastAdvanceTick;
            bool threatening = idleTicks > Sim.IdleGraceTicks;

            _shadowQuad.SetActive(threatening);
            if (!threatening) return;

            int line = Sim.IdleLineRow(state);

            // Flat on the ground rather than a slab. The first version was a
            // 1-unit-tall cube at y=0.3, which spanned the chicken's own height
            // and hid it completely behind the very thing chasing it.
            _shadowQuad.transform.localScale = new Vector3(Sim.Cols + 4f, 0.02f, 7f);
            _shadowQuad.transform.localPosition =
                new Vector3((Sim.Cols - 1) * 0.5f, 0.015f, line - 3.4f);

            // Darken as it closes, so the pressure is legible without a UI element.
            float urgency = Mathf.InverseLerp(state.Row - 4f, state.Row, line);
            Tint(_shadowQuad, Color.Lerp(idleShadowNear, idleShadowClose, urgency));
        }

        private GameObject TakeMover()
        {
            var go = _moverPool.Count > 0 ? _moverPool.Pop() : BuildQuad("Mover", Color.white);
            go.SetActive(true);
            go.transform.SetParent(_root, false);
            _movers.Add(go);
            return go;
        }

        internal GameObject BuildQuad(string name, Color color)
        {
            // NOT GameObject.CreatePrimitive. It attaches a collider, and the
            // Physics module is stripped from the player build because nothing in
            // this game uses it — so on device CreatePrimitive fails with
            // "Can't add component because class 'BoxCollider' doesn't exist",
            // the world never finishes building, and Unity never sends READY.
            // Invisible in the editor, fatal on a phone. See PrimitiveMesh.
            var go = PrimitiveMesh.CubeObject(name, _sharedMaterial);
            Tint(go, color);
            return go;
        }

        internal void Tint(GameObject go, Color color)
        {
            var r = go.GetComponent<MeshRenderer>();
            var block = new MaterialPropertyBlock();
            r.GetPropertyBlock(block);
            // URP Unlit uses _BaseColor; the built-in fallback uses _Color.
            block.SetColor("_BaseColor", color);
            block.SetColor("_Color", color);
            r.SetPropertyBlock(block);
        }

        internal Color ObstacleColor => obstacle;
    }

    /// <summary>Static scenery for one row, built once when the row is recycled in.</summary>
    public class RowObstacles : MonoBehaviour
    {
        private readonly List<GameObject> _spawned = new List<GameObject>();

        public void Rebuild(WorldView world, uint seed, int row, int kind)
        {
            foreach (var go in _spawned) Destroy(go);
            _spawned.Clear();

            if (kind != Sim.RowGrass) return;

            int mask = Sim.GrassObstacleMask(seed, row);
            for (int col = 0; col < Sim.Cols; col++)
            {
                if ((mask & (1 << col)) == 0) continue;

                var go = world.BuildQuad("Obstacle", world.ObstacleColor);
                go.transform.SetParent(transform, false);
                // Undo the parent row's non-uniform scale so obstacles stay square.
                go.transform.localScale = new Vector3(0.72f / Sim.Cols, 1.1f, 0.72f);
                go.transform.localPosition = new Vector3(
                    (col - (Sim.Cols - 1) * 0.5f) / Sim.Cols, 0.55f, 0f);
                _spawned.Add(go);
            }
        }

        private void OnDestroy()
        {
            foreach (var go in _spawned) if (go != null) Destroy(go);
            _spawned.Clear();
        }
    }
}
